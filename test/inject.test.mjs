import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Why: every conversation used to receive every OTHER conversation's project/topic titles, the
// cross-session hot entities, the cross-agent consensus AND a fresh top-2 keyword hit on EVERY
// turn -- all read from one global store with no scope of any kind. A conversation about one
// project was being fed another project's content. Nothing was "broken"; there was just no
// notion of a domain. These tests pin the new default (scoped) and keep the old behaviour
// reachable behind DSH_ACP_MEMORY_INJECT=full.
//
// DSH_HOME must be redirected BEFORE the module is used: sessionsFile() derives from it and a
// test must never touch the real ~/.dsh/memory/sessions.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'acp-mem-test-'));
const { buildFirstInjection, buildHitInjection, buildReinjection, injectMode, memoryIndex } =
  await import('../.test-build/dsh/inject.js');

// Scope defaults to LEGACY on purpose: a row that does not declare a domain is of unknown
// provenance, and unknown provenance must never be treated as universally true.
const row = (o) => ({
  id: 'x', level: 'fact', content: '', title: null, project: null, subcategory: null,
  scope_kind: 'legacy', scope_id: 'legacy',
  corrected: false, status: 'active', keywords: [], importance: 1,
  // Field names must match MemoryRow (created_at/updated_at): the previous fixture used
  // createdAt, so the recency decay was computed from undefined and EVERY recall hit scored NaN
  // -- a test that looked like it passed for the right reason was passing because nothing came back.
  created_at: Date.now(), updated_at: Date.now(), ...o,
});

const ROWS = [
  row({ id: 'u1', level: 'user', content: '用户偏好用中文交流（说中文）。', scope_kind: 'global', scope_id: '' }),
  row({ id: 'l1', level: 'lesson', content: 'OC 的 NotebookLM 接線（别的对话的内容）' }),
  row({ id: 't1', level: 'topic', title: 'OC 工作区结构', content: '别的对话的话题' }),
  row({ id: 'f1', level: 'fact', content: 'dsh 相关的条目', project: 'dsh', scope_kind: 'project', scope_id: 'dsh' }),
];
const fakeDb = (rows = ROWS) => ({ raw: () => rows });

test('injectMode defaults to scoped; full/off must be asked for explicitly', () => {
  assert.equal(injectMode({}), 'scoped');
  assert.equal(injectMode({ DSH_ACP_MEMORY_INJECT: 'off' }), 'off');
  assert.equal(injectMode({ DSH_ACP_MEMORY_INJECT: 'FULL' }), 'full');
  assert.equal(injectMode({ DSH_ACP_MEMORY_INJECT: 'nonsense' }), 'scoped');
});

test('scoped first injection carries global identity + an index, and NO other conversation', async () => {
  const inj = await buildFirstInjection(fakeDb(), 's-scoped', '随便一句话');
  assert.ok(inj, 'expected an injection');
  const t = inj.text;
  assert.match(t, /【关于你\/用户】/, t);
  assert.match(t, /用户偏好用中文交流/, t);
  assert.match(t, /【记忆索引】/, t);
  assert.match(t, /\(未标注\) 1/, 'the index reports what exists, by domain: ' + t);
  assert.ok(!t.includes('OC 工作区结构'), 'another conversation topic title leaked: ' + t);
  assert.ok(!t.includes('NotebookLM'), 'another conversation content leaked: ' + t);
  assert.ok(!t.includes('跨会话热实体'), 'cross-session hot entities leaked: ' + t);
  assert.ok(!t.includes('跨 agent 共识'), 'cross-agent consensus leaked: ' + t);
  assert.ok(!t.includes('可能相关记忆'), 'per-turn hits leaked into the first injection: ' + t);
});

// An undated assertion is indistinguishable from a current one -- that is how a statement from a
// week ago read as present tense and the agent resumed last week's work.
test('an injected identity line is dated', async () => {
  const inj = await buildFirstInjection(fakeDb(), 's-dated', '', 2, { mode: 'scoped' });
  assert.match(inj.text, /\(\d{4}-\d{2}-\d{2}\) 用户偏好用中文交流/, inj.text);
});

test('a retired row is neither injected nor returned unless explicitly asked for', async () => {
  const rows = [
    row({ id: 'u-dead', level: 'user', content: '用户偏好：旧偏好', scope_kind: 'global', scope_id: '', invalidated_at: Date.now() - 1000 }),
    row({ id: 'u-live', level: 'user', content: '用户偏好用中文交流（说中文）。', scope_kind: 'global', scope_id: '' }),
  ];
  const inj = await buildFirstInjection(fakeDb(rows), 's-retired', '', 2, { mode: 'scoped' });
  assert.ok(!inj.text.includes('旧偏好'), 'a retired row must not be injected: ' + inj.text);
  assert.match(inj.text, /用户偏好用中文交流/, inj.text);
  assert.match(inj.text, /已失效 1 条/, 'the index must count what was retired: ' + inj.text);

  const { recallSearch } = await import('../.test-build/core/recall.js');
  const q = { query: '用户偏好', scope: 'any', limit: 5 };
  const live = recallSearch(rows, q);
  assert.ok(!live.some((h) => h.id === 'u-dead'), 'retired rows stay out of recall');
  const audited = recallSearch(rows, { ...q, includeInvalidated: true });
  assert.ok(audited.some((h) => h.id === 'u-dead'), 'includeInvalidated is the auditing opt-in');
});

test('full mode still reproduces the legacy dump (the escape hatch stays honest)', async () => {
  const inj = await buildFirstInjection(fakeDb(), 's-full', '随便一句话', 2, { mode: 'full' });
  const t = inj.text;
  assert.match(t, /【记忆导引】可用 memory_project 查看详情：/, t);
  assert.match(t, /OC 工作区结构/, 'full mode must still list topics: ' + t);
});

test('off mode injects nothing at all', async () => {
  assert.equal(await buildFirstInjection(fakeDb(), 's-off', 'q', 2, { mode: 'off' }), null);
  assert.equal(buildReinjection(fakeDb(), 's-off', { mode: 'off' }), null);
});

test('the per-turn hit push is gone unless full mode is asked for', async () => {
  assert.equal(await buildHitInjection(fakeDb(), 's-scoped', 'NotebookLM'), null);
  assert.equal(await buildHitInjection(fakeDb(), 's-off', 'NotebookLM', 2, { mode: 'off' }), null);
  const full = await buildHitInjection(fakeDb(), 's-full', 'NotebookLM', 2, { mode: 'full' });
  assert.ok(full === null || typeof full.text === 'string', 'full mode must not throw');
});

test('post-compaction re-injection keeps the identity block but drops the topic dump', async () => {
  const scoped = buildReinjection(fakeDb(), 's-reinj', { mode: 'scoped' });
  assert.ok(scoped, 'identity memories exist, so something is injected');
  assert.match(scoped.text, /用户偏好用中文交流/, scoped.text);
  assert.ok(!scoped.text.includes('【进行中话题】'), scoped.text);
  assert.ok(!scoped.text.includes('OC 工作区结构'), scoped.text);
  const full = buildReinjection(fakeDb(), 's-reinj-full', { mode: 'full' });
  assert.match(full.text, /【进行中话题】/, full.text);
});

test('looksLikeDialogue spots a captured turn, not a statement', async () => {
  const { looksLikeDialogue } = await import('../.test-build/core/recall.js');
  assert.equal(looksLikeDialogue('user: hi\nassistant: hello'), true);
  assert.equal(looksLikeDialogue('随便一段话\nassistant: 回答'), true);
  assert.equal(looksLikeDialogue('用户偏好用中文交流（说中文）。'), false);
});

// Production rows 1 and 2 of the user layer are 500-char turn dumps whose text starts with
// "user: " -- and the auto-classifier put them there because "我**不喜欢**你" contains "我喜欢".
// They were then injected as the user's identity into every conversation on the machine.
test('a captured dialogue dump can never be injected as a user preference', async () => {
  const rows = [
    row({ id: 'u-bad', level: 'user', content: 'user: 等等，你误会我的意思了\nassistant: 明白了', scope_kind: 'global', scope_id: '' }),
    row({ id: 'u-big', level: 'user', content: '偏'.repeat(300), scope_kind: 'global', scope_id: '' }),
    row({ id: 'u-ok', level: 'user', content: '用户偏好用中文交流（说中文）。', scope_kind: 'global', scope_id: '' }),
  ];
  const inj = await buildFirstInjection(fakeDb(rows), 's-dialogue', '', 2, { mode: 'scoped' });
  assert.match(inj.text, /用户偏好用中文交流/, inj.text);
  assert.ok(!inj.text.includes('误会我的意思'), 'a captured turn leaked as identity: ' + inj.text);
  assert.ok(!inj.text.includes('偏'.repeat(300)), 'an oversized capture leaked as identity: ' + inj.text);
});

// The heart of the fix: a row that never declared a domain is NOT eligible for injection, even
// when it looks exactly like a preference. 309 of 320 production rows were in that state and every
// one of them was eligible for every conversation on the machine.
test('an unscoped row is never injected, however much it looks like identity', async () => {
  const rows = [
    row({ id: 'u-noscope', level: 'user', content: '用户偏好用中文交流（说中文）。' }),
  ];
  const inj = await buildFirstInjection(fakeDb(rows), 's-noscope', '', 2, { mode: 'scoped' });
  assert.ok(!inj.text.includes('用户偏好用中文交流'), 'an unscoped row leaked into identity: ' + inj.text);
});

test('memoryIndex names unlabelled rows instead of pretending they are global', () => {
  const idx = memoryIndex(ROWS);
  assert.match(idx, /\(未标注\) 1/, 'only fact/lesson/project rows carry a domain: ' + idx);
  assert.match(idx, /dsh 1/, idx);
  assert.match(idx, /话题 1 条/, idx);
});
