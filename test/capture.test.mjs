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
