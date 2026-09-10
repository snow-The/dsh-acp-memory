/**
 * Fuzz the capture path with hostile event shapes.
 *
 * This is where a week-long silent outage happened, so the bar is explicit: whatever the
 * harness hands the hook, capture must either write something sane or write nothing -
 * never throw, never hang, never corrupt the store.
 *
 * Adversarial inputs: null/undefined entries, elements that are not objects, getters that
 * throw, cyclic objects, 2 MB strings, arrays where objects are expected, unicode
 * surrogates, prototype-polluting keys.
 *
 *   node test/fuzz-capture.mjs [--iters=300]
 * (requires the pretest build in .test-build/)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'fuzz-capture-'));
const cap = await import('../.test-build/dsh/capture.js');
const dbmod = await import('../.test-build/core/db.js');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ITERS = Number(args.iters ?? 300);
let a = 424242;
const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (l) => l[Math.floor(rand() * l.length) % l.length];

const throwingGetter = { type: 'user/message', get data() { throw new Error('hostile getter'); } };
const cyclic = { type: 'user/message', data: {} };
cyclic.data.self = cyclic;
const polluting = JSON.parse('{"type":"user/message","data":{"__proto__":{"polluted":true},"content":[{"type":"text","text":"proto"}]}}');

const eventCorpus = [
  () => null,
  () => undefined,
  () => 42,
  () => 'a string event',
  () => throwingGetter,
  () => cyclic,
  () => polluting,
  () => ({ type: 'turn/start' }),
  () => ({ type: 'turn/end' }),
  () => ({ type: 'user/message' }),
  () => ({ type: 'user/message', data: null }),
  () => ({ type: 'user/message', data: { content: null } }),
  () => ({ type: 'user/message', data: { content: 'not an array' } }),
  () => ({ type: 'user/message', data: { content: [null, 1, 'x', { type: 'text', text: 42 }] } }),
  () => ({ type: 'user/message', data: { content: [{ type: 'text', text: '\uD800\uDFFF'.repeat(10) }] } }),
  () => ({ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] } }),
  () => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'normal reply about a bug and a lesson' }] } } }),
  () => ({ type: 'assistant/message', data: { message: null } }),
  () => ({ type: 'checkpoint', data: { content: [{ type: 'text', text: '<compacted-summary>' + 'y'.repeat(1000) }] } }),
];

const problems = [];
const db = dbmod.openDb();
for (let i = 0; i < ITERS; i++) {
  const n = Math.floor(rand() * 6);
  const events = Array.from({ length: n }, () => eventCorpus[Math.floor(rand() * eventCorpus.length) % eventCorpus.length]());
  if (rand() < 0.2) events.push(...events);                       // duplicates
  const started = Date.now();
  try {
    const text = cap.scanTurnText(events);
    if (typeof text !== 'string') problems.push({ fn: 'scanTurnText', why: 'SHAPE: ' + typeof text });
    const resolved = cap.sessionEvents({ ownEvents: () => events });
    if (!Array.isArray(resolved)) problems.push({ fn: 'sessionEvents', why: 'SHAPE: not an array' });
    const written = await cap.captureTurn(db, events, cap.DEFAULT_CAPTURE_CONFIG, null);
    if (!Number.isInteger(written) || written < 0) problems.push({ fn: 'captureTurn', why: 'SHAPE: written=' + written });
  } catch (err) {
    problems.push({ fn: 'capture', why: 'THREW: ' + (err && err.message ? err.message : String(err)) });
  }
  const ms = Date.now() - started;
  if (ms > 4000) problems.push({ fn: 'capture', why: 'SLOW: ' + ms + 'ms' });
}
const tally = (key) => { const acc = {}; for (const p of problems) { const k = key(p); acc[k] = (acc[k] ?? 0) + 1; } return acc; };
console.log(JSON.stringify({ iterations: ITERS, problems: problems.length, byFunction: tally((p) => p.fn), byReason: tally((p) => String(p.why).split(':')[0]), samples: problems.slice(0, 5) }, null, 1));
process.exit(problems.length ? 1 : 0);
