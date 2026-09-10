/**
 * Regression tests for the silent auto-capture outage (2026-09-11).
 *
 * Two defects, both invisible from the outside:
 *   1. db.create() spread the caller's object over its defaults, so an omitted optional
 *      field arrived as `undefined`. node:sqlite refuses to bind undefined and throws
 *      "Provided value cannot be bound to SQLite parameter N" - the write never happened.
 *   2. captureTurn() wrapped everything in `catch { return 0 }`, so that exception
 *      surfaced as "captured nothing", which is also the normal, healthy result.
 *
 * Together they let auto-capture write zero rows for days while every check looked green.
 * These tests fail if either half comes back.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dbmod; let cap; let pipe;
before(async () => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'acpmem-'));
  dbmod = await import('../.test-build/core/db.js');
  pipe = await import('../.test-build/core/pipeline.js');
  cap = await import('../.test-build/dsh/capture.js');
});

test('the cross-agent bridge is null-safe when the relation layer is absent', async () => {
  const { crossAgentAvailable, crossAgentHot, crossAgentHits } = await import('../.test-build/core/crossagent.js');
  process.env.DSH_NOTEMAP_DB = join(tmpdir(), 'definitely-missing-' + Date.now(), 'graph.db');
  assert.equal(await crossAgentAvailable(), false, 'missing store means unavailable, not a crash');
  assert.deepEqual(await crossAgentHot(3), []);
  assert.deepEqual(await crossAgentHits('anything', 3), []);
});

test('the cross-agent bridge reads consensus nodes and ignores everything else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xagent-'));
  const dbPath = join(dir, 'graph.db');
  const { DatabaseSync } = await import('node:sqlite');
  const seed = new DatabaseSync(dbPath);
  seed.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, type TEXT, title TEXT, content TEXT, meta TEXT, created_at TEXT, updated_at TEXT)');
  const insert = seed.prepare('INSERT INTO nodes (id, type, title, content, meta, created_at, updated_at) VALUES (?,?,?,?,?,?,?)');
  insert.run('digest:r32', 'consensus', 'r32', '', JSON.stringify({ sources: 3, agent_kinds: ['main', 'subagent'], mentions: 42, score: 1.5, kind: 'project' }), '', '');
  insert.run('note:x', 'note', 'r32 notes', '', '{}', '', '');
  seed.close();
  process.env.DSH_NOTEMAP_DB = dbPath;
  const { crossAgentAvailable, crossAgentHot, crossAgentHits } = await import('../.test-build/core/crossagent.js');
  assert.equal(await crossAgentAvailable(), true);
  const hot = await crossAgentHot(5);
  assert.equal(hot.length, 1, 'only consensus nodes count');
  assert.equal(hot[0].title, 'r32');
  assert.equal(hot[0].sources, 3);
  assert.deepEqual(hot[0].agent_kinds, ['main', 'subagent']);
  const hits = await crossAgentHits('tell me about r32 please', 2);
  assert.equal(hits.length, 1, 'a query token matches the digest title');
});

test('sessionEvents() reads the harness Session shape, not a phantom .events', () => {
  // the real Session: methods + a private log, and NO `events` property
  const real = { ownEvents: () => [{ type: 'turn/end' }], log: [{ type: 'x' }] };
  assert.equal(cap.sessionEvents(real).length, 1, 'ownEvents() wins');
  assert.deepEqual(cap.sessionEvents({ log: [1, 2, 3] }), [1, 2, 3], 'log is the fallback');
  assert.deepEqual(cap.sessionEvents({ snapshotEvents: () => [9] }), [9], 'snapshotEvents works too');
  assert.deepEqual(cap.sessionEvents({}), [], 'no accessor means no events');
  assert.deepEqual(cap.sessionEvents(null), [], 'null-safe');
  assert.deepEqual(cap.sessionEvents({ ownEvents: () => { throw new Error('boom'); }, log: [7] }), [7], 'a throwing accessor falls through');
});

test('create() accepts an omitted optional field instead of throwing', () => {
  const db = dbmod.openDb();
  // `project` is optional and simply absent here - exactly what the capture path produces
  const row = db.create('lesson', { content: 'omitted optional field', keywords: ['a', 'b'] });
  assert.ok(row && row.id, 'row must be written');
  assert.equal(row.content, 'omitted optional field');
  assert.deepEqual(row.keywords, ['a', 'b'], 'keywords round-trip as an array');
  db.close();
});

test('create() still rejects nothing and stores explicit nulls', () => {
  const db = dbmod.openDb();
  const row = db.create('fact', { content: 'explicit null project', project: null, keywords: [] });
  assert.ok(row && row.id);
  db.close();
});

test('captureTurn writes an entry for real turn text', async () => {
  const db = dbmod.openDb();
  const events = [
    { type: 'turn/start', data: {} },
    { type: 'user/message', data: { content: [{ type: 'text', text: '这里有个坑：错误地绑定了 undefined' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已修复这个 bug，教训是不要吞异常。' }] } } },
    { type: 'turn/end', data: {} },
  ];
  const written = await cap.captureTurn(db, events, cap.DEFAULT_CAPTURE_CONFIG, null);
  assert.equal(written, 1, 'a turn with lesson-flavoured text must produce one entry');
  const lessons = db.list('lesson');
  assert.ok(lessons.some((r) => r.content.includes('教训')), 'the lesson is retrievable afterwards');
  db.close();
});

test('captureTurn is idempotent for identical text (dedup holds)', async () => {
  const db = dbmod.openDb();
  const events = [
    { type: 'turn/start', data: {} },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'dedup probe 唯一文本 ABC123' }] } },
    { type: 'turn/end', data: {} },
  ];
  const first = await cap.captureTurn(db, events, cap.DEFAULT_CAPTURE_CONFIG, null);
  const second = await cap.captureTurn(db, events, cap.DEFAULT_CAPTURE_CONFIG, null);
  assert.equal(first, 1);
  assert.equal(second, 0, 'the same text must not be stored twice');
  db.close();
});
