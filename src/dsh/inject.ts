/**
 * acp-memory — dsh/inject.ts（M4 注入机制）
 *
 * 借鉴 meow-memory 的注入模式，融合 ACP：
 * - 首轮注入：soul/user 全量 + 记忆索引（+ full 模式下的导引/热实体/命中）
 * - 每轮 pre-step：动态命中（仅 full 模式）
 * - 压缩重注入：compaction/end 信号 → 下一用户消息轮重注入
 * - 已见去重：~/.dsh/memory/sessions/<id>.json 记录 injected/searched
 *
 * 隔离（2026-09-13）：注入原先没有任何"域"的概念——所有 project/topic 标题、跨会话热实体、
 * 跨 agent 共识、每轮 top-2 命中，全部来自同一个全局库，于是 A 对话的内容被灌进 B 对话。
 * 现在默认 scoped：只注入全局身份（soul/user/rules）+ 一行"有什么"的索引，其余一律按需查询。
 * 注意：会话 header 里的 cwd 在本机恒为 C:\Users\snow（不是工作区），所以按路径分域做不到，
 * 而 fact/lesson 的历史行 309/320 条 project 为空——无域可依时，答案就是"不注入，让人来问"。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { MemoryDb, MemoryRow } from '../core/db.js';
import { recallSearch, topMemories } from '../core/recall.js';
import { acpGraphAvailable, acpGraphRecall, acpGraphHotEntities } from '../core/acp.js';
import { crossAgentAvailable, crossAgentHot, crossAgentHits } from '../core/crossagent.js';

export interface SessionSeen {
  injected: string[];
  searched: string[];
  reinjectPending: boolean;
}

export function sessionsDir(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')): string {
  return join(home, 'memory', 'sessions');
}

export function sessionsFile(sid: string): string {
  return join(sessionsDir(), sid + '.json');
}

export function readSeen(sid: string): SessionSeen {
  try {
    const p = JSON.parse(readFileSync(sessionsFile(sid), 'utf8')) as Record<string, unknown>;
    return {
      injected: Array.isArray(p.injected) ? p.injected.filter((x): x is string => typeof x === 'string') : [],
      searched: Array.isArray(p.searched) ? p.searched.filter((x): x is string => typeof x === 'string') : [],
      reinjectPending: p.reinjectPending === true,
    };
  } catch {
    return { injected: [], searched: [], reinjectPending: false };
  }
}

function writeSeen(sid: string, seen: SessionSeen): void {
  try {
    mkdirSync(dirname(sessionsFile(sid)), { recursive: true });
    writeFileSync(sessionsFile(sid), JSON.stringify(seen));
  } catch (err) { console.warn('[acp-memory] writeSeen failed:', err instanceof Error ? err.message : String(err)); }
}

export function markInjected(sid: string, ids: string[]): void {
  const seen = readSeen(sid);
  seen.injected = Array.from(new Set([...seen.injected, ...ids]));
  writeSeen(sid, seen);
}

export function markSearched(sid: string, ids: string[]): void {
  const seen = readSeen(sid);
  seen.searched = Array.from(new Set([...seen.searched, ...ids]));
  writeSeen(sid, seen);
}

export function markReinjectPending(sid: string): void {
  const seen = readSeen(sid);
  seen.reinjectPending = true;
  writeSeen(sid, seen);
}

export function clearReinjectPending(sid: string): void {
  const seen = readSeen(sid);
  seen.reinjectPending = false;
  writeSeen(sid, seen);
}

export function isReinjectPending(sid: string): boolean {
  return readSeen(sid).reinjectPending;
}

/** 过滤掉已见记忆（首轮注入后的命中检索排除已注入项）。 */
function unseen(rows: MemoryRow[], seenIds: string[]): MemoryRow[] {
  const set = new Set(seenIds);
  return rows.filter((r) => !set.has(r.id));
}

/**
 * 自动注入的尺度。
 * - scoped（默认）：只注入全局身份 + 一行索引。跨对话内容一律不推，改为按需查询。
 * - full：2026-09-13 之前的行为（项目/话题清单 + 热实体 + 跨会话共识 + 每轮命中）。
 * - off：完全不自动注入。
 */
export type InjectMode = 'scoped' | 'full' | 'off';

export function injectMode(env: Record<string, string | undefined> = process.env): InjectMode {
  const v = String(env.DSH_ACP_MEMORY_INJECT ?? '').trim().toLowerCase();
  return v === 'full' || v === 'off' ? v : 'scoped';
}

/**
 * 记忆索引：只说"库里有哪几个域、各多少条"，不说内容。
 * 这是全域唯一该常驻的东西——工具与环境的大概索引；内容靠 memory_search / memory_project 取。
 */
export function memoryIndex(rows: MemoryRow[]): string {
  const byProject = new Map<string, number>();
  for (const r of rows) {
    if (r.level !== 'fact' && r.level !== 'lesson' && r.level !== 'project') continue;
    // Report the SCOPE, not the legacy free-text project column: they are different facts, and
    // conflating them is what let 'no domain' read as 'every domain'.
    const key = r.scope_kind === 'project' ? (String(r.scope_id ?? '').trim() || '(未标注)')
      : r.scope_kind === 'global' ? '(全局)' : r.scope_kind === 'session' ? '(本会话)' : '(未标注)';
    byProject.set(key, (byProject.get(key) ?? 0) + 1);
  }
  const parts = [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => k + ' ' + n);
  const topics = rows.filter((r) => r.level === 'topic').length;
  const episodes = rows.filter((r) => r.level === 'episode').length;
  const retired = rows.filter((r) => r.invalidated_at != null).length;
  return '【记忆索引】' + parts.join(' / ') + '；话题 ' + topics + ' 条'
    + (episodes ? '；原始 episode ' + episodes + ' 条（可搜、不可注入）' : '')
    + (retired ? '；已失效 ' + retired + ' 条' : '')
    + '。其它对话的内容不再自动注入，需要时用 memory_search / memory_project / acp_recall 查询。';
}

export interface Injection {
  text: string;
  injectedIds: string[];
}

export interface InjectOptions {
  mode?: InjectMode;
}

/** 首轮注入：scoped = soul/user/rules + 索引；full = 原来的导引 + 热实体 + 共识 + 命中 top-2。 */
export async function buildFirstInjection(db: MemoryDb, sid: string, queryText: string, hitTopK = 2, opts: InjectOptions = {}): Promise<Injection | null> {
  const mode = opts.mode ?? injectMode();
  if (mode === 'off') return null;
  const rows = db.raw();
  if (rows.length === 0) return null;
  const seen = readSeen(sid);
  const parts: string[] = ['===== 长期记忆 ====='];

  // soul/user 全量 + rules importance≥2 —— 真正跨对话成立的东西
  const top = topMemories(rows);
  if (top.length) {
    parts.push('【关于你/用户】');
    for (const r of top) {
      // Date every injected identity line. An undated assertion is indistinguishable from a
      // current one, which is how a statement from last week read as present tense.
      const when = r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '?';
      parts.push('- [' + r.level + '] (' + when + ') ' + r.content);
    }
  }

  if (mode === 'scoped') {
    parts.push(memoryIndex(rows));
    parts.push('【记忆导引】如需更多记忆，用 memory_search / memory_project / acp_recall 查询。');
    writeSeen(sid, seen);
    return { text: parts.join('\n'), injectedIds: seen.injected };
  }

  // ---- full：旧行为，仅作逃生门保留 ----
  const projects = rows.filter((r) => r.level === 'project');
  const topics = rows.filter((r) => r.level === 'topic');
  if (projects.length || topics.length) {
    parts.push('【记忆导引】可用 memory_project 查看详情：');
    for (const r of projects.slice(0, 8)) parts.push('- project: ' + (r.title ?? r.content));
    for (const r of topics.slice(0, 8)) parts.push('- topic: ' + (r.title ?? r.content));
  }

  if (acpGraphAvailable()) {
    const hot = acpGraphHotEntities(5);
    if (hot.length) parts.push('【跨会话热实体】' + hot.map((h) => h.node).join(', '));
  }

  if (queryText) {
    // Explicit session scope: 'any' is reserved for user-driven search, never for automatic injection.
  const hits = recallSearch(unseen(rows, seen.injected), { query: queryText, limit: hitTopK, scope: { kind: 'session', id: sid } });
    if (hits.length) {
      parts.push('【可能相关记忆】');
      for (const h of hits) {
        parts.push('- [' + h.level + '] ' + h.content);
        seen.injected.push(h.id);
      }
    }
  }

  if (await crossAgentAvailable()) {
    const hot = await crossAgentHot(5);
    if (hot.length) {
      parts.push('【跨会话/跨 agent 共识】' + hot.map((h) => h.title + (h.sources > 1 ? '(' + h.sources + ')' : '')).join(', '));
    }
  }

  parts.push('【记忆导引】如需更多记忆，用 memory_search / acp_recall 查询。');
  writeSeen(sid, seen);
  return { text: parts.join('\n'), injectedIds: seen.injected };
}

/**
 * 每轮命中注入。scoped 模式下返回 null：
 * 没有工作区信号时，"每轮从全局库捞 2 条"就是串味的来源，宁可一条都不推。
 */
export async function buildHitInjection(db: MemoryDb, sid: string, queryText: string, hitTopK = 2, opts: InjectOptions = {}): Promise<Injection | null> {
  const mode = opts.mode ?? injectMode();
  if (mode !== 'full') return null;
  const rows = db.raw();
  const seen = readSeen(sid);
  // Explicit session scope: 'any' is reserved for user-driven search, never for automatic injection.
  const hits = recallSearch(unseen(rows, seen.injected), { query: queryText, limit: hitTopK, scope: { kind: 'session', id: sid } });
  if (hits.length === 0 && !acpGraphAvailable()) return null;

  const parts: string[] = ['可能相关的记忆，仅供参考：'];
  const ids: string[] = [];
  for (const h of hits) {
    parts.push('- [' + h.level + '] ' + h.content);
    ids.push(h.id);
  }
  if (acpGraphAvailable()) {
    const acpHits = acpGraphRecall(queryText, 2);
    for (const a of acpHits) {
      parts.push('- [acp] ' + a.summary.slice(0, 120));
    }
  }
  const cross = await crossAgentHits(queryText, 2);
  for (const c of cross) {
    const who = c.agent_kinds.length > 1 ? c.agent_kinds.join('+') : c.agent_kinds[0] ?? 'main';
    parts.push('- [cross-agent] ' + c.title + '（' + c.sources + ' 个上下文/' + who + ' 都提到）');
  }
  markInjected(sid, ids);
  return { text: parts.join('\n'), injectedIds: ids };
}

/** 压缩重注入：scoped = 全局身份 + 索引；full = 原来的 top + 话题清单。 */
export function buildReinjection(db: MemoryDb, sid: string, opts: InjectOptions = {}): Injection | null {
  const mode = opts.mode ?? injectMode();
  if (mode === 'off') return null;
  const rows = db.raw();
  const seen = readSeen(sid);
  clearReinjectPending(sid);
  const top = topMemories(rows);
  if (top.length === 0) return null;
  const parts: string[] = ['===== 长期记忆（压缩后重注入）====='];
  for (const r of top.slice(0, 12)) parts.push('- [' + r.level + '] ' + r.content);
  if (mode === 'scoped') {
    const idx = memoryIndex(rows);
    if (idx) parts.push(idx);
    return { text: parts.join('\n'), injectedIds: [] };
  }
  const topics = rows.filter((r) => r.level === 'topic').slice(0, 6);
  if (topics.length) {
    parts.push('【进行中话题】');
    for (const r of topics) parts.push('- ' + (r.title ?? r.content));
  }
  return { text: parts.join('\n'), injectedIds: [] };
}
