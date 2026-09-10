import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
// The pure core is built separately for tests (see pretest) so host modules never resolve here.
import { ftsPhrase } from '../.test-build/core/acp.js';

// Regression for a real production line:
//   [acp-memory] ACP entity FTS query failed (cross-session hits lost): no such column: c
//
// The old builder was `JSON.stringify(q) + '*' ==="as one quoted phrase"'*'.` Two failure modes, both
// silent from the caller's point of view:
//   * a double quote inside the query closed the phrase early, so the rest was parsed as FTS
//     syntax - a path (`c:\users\...`) became a COLUMN FILTER and the query threw;
//   * a path / parentheses / operators just matched nothing (a prefix phrase of the whole
//     sentence), so cross-session recall quietly returned zero hits.
// The new builder strips FTS syntax, quotes every token and OR-joins them with a prefix marker.

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE node_fts USING fts5(id UNINDEXED, title, kind)');
  db.prepare('INSERT INTO node_fts (id, title, kind) VALUES (?, ?, ?)')
    .run('n1', 'dsh notemap graph network', 'tool');
  return db;
}
const match = (db, phrase) => db.prepare('SELECT id FROM node_fts WHERE node_fts MATCH ? LIMIT 4').all(phrase);

test('the old form was broken in both ways (guards the bug, not the fix)', () => {
  const db = freshDb();
  // (a) a double quote made it throw
  const withQuote = 'he said "dsh" about c:\\users\\snow';
  assert.throws(() => match(db, JSON.stringify(withQuote) + '*'), /fts5|syntax/i);
  // (b) a plain path made it silently find nothing
  const pathish = 'c:\\users\\snow\\.dsh notemap';
  assert.equal(match(db, JSON.stringify(pathish) + '*').length, 0);
  db.close();
});

test('hostile user text can no longer throw or smuggle FTS syntax', () => {
  const db = freshDb();
  const hostile = ['c:\\users\\snow\\.dsh', 'he said "dsh"', 'note* map', 'a NOT b OR c AND d', '((( unbalanced', '', '   ', '"', 'dsh:notemap'];
  for (const q of hostile) {
    const phrase = ftsPhrase(q);
    assert.equal(typeof phrase, 'string');
    // after removing quoted tokens (with their optional prefix marker) no raw FTS syntax may survive
    const bare = phrase.replace(/"\*/g, '').replace(/"/g, '');
    assert.ok(!/[():^*]/.test(bare), `raw FTS syntax leaked for ${JSON.stringify(q)}: ${phrase}`);
    assert.doesNotThrow(() => match(db, phrase));
  }
  db.close();
});

test('normal queries still hit, and prefixes still work', () => {
  const db = freshDb();
  assert.ok(match(db, ftsPhrase('notemap network')).length >= 1, 'expected a hit for "notemap network"');
  assert.ok(match(db, ftsPhrase('note')).length >= 1, 'prefix "note" should still reach notemap');
  assert.ok(match(db, ftsPhrase('c:\\users\\snow\\.dsh notemap')).length >= 1, 'the path case that used to return zero');
  db.close();
});

test('tokens are quoted and OR-joined with a prefix marker', () => {
  assert.equal(ftsPhrase('alpha beta gamma'), '"alpha"* OR "beta"* OR "gamma"*');
  assert.equal(ftsPhrase(''), '""');
  assert.equal(ftsPhrase('a'), '""');   // single-char noise is dropped
});
