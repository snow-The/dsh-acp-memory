/**
 * acp-memory — dsh/inject.ts（M4 注入机制）
 *
 * 借鉴 meow-memory 的注入模式，融合 ACP：
 * - 首轮注入：soul/user 全量 + 记忆导引（project/topic 标题）+ ACP 热实体 + 关键词命中 top-2
 * - 每轮 pre-step：动态命中（top-2）+ ACP graph recall 融合
 * - 压缩重注入：compaction/end 信号 → 下一用户消息轮重注入
 * - 已见去重：~/.dsh/memory/sessions/<id>.json 记录 injected/searched
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { MemoryDb, MemoryRow } from '../core/db.js';
import { recallSearch, topMemories, hotKeywords } from '../core/recall.js';
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

export interface Injection {
  text: string;
  injectedIds: string[];
}

/** 首轮注入：soul/user 全量 + rules importance≥2 + 导引 + ACP 热实体 + 命中 top-2。 */
export async function buildFirstInjection(db: MemoryDb, sid: string, queryText: string, hitTopK = 2): Promise<Injection | null> {
  const rows = db.raw();
  const seen = readSeen(sid);
  const parts: string[] = ['===== 长期记忆 ====='];

  // soul/user 全量 + rules importance≥2
  const top = topMemories(rows);
  if (top.length) {
    parts.push('【关于你/用户】');
    for (const r of top) {
      parts.push('- [' + r.level + '] ' + r.content);
    }
  }

  // 记忆导引：project/topic 标题列表
  const projects = rows.filter((r) => r.level === 'project');
  const topics = rows.filter((r) => r.level === 'topic');
  if (projects.length || topics.length) {
    parts.push('【记忆导引】可用 memory_project 查看详情：');
    for (const r of projects.slice(0, 8)) parts.push('- project: ' + (r.title ?? r.content));
    for (const r of topics.slice(0, 8)) parts.push('- topic: ' + (r.title ?? r.content));
  }

  // ACP 热实体
  if (acpGraphAvailable()) {
    const hot = acpGraphHotEntities(5);
    if (hot.length) parts.push('【跨会话热实体】' + hot.map((h) => h.node).join(', '));
  }

  // 关键词命中 top-2（首轮也命中，因为第一条用户消息已到）
  if (queryText) {
    const hits = recallSearch(unseen(rows, seen.injected), { query: queryText, limit: hitTopK });
    if (hits.length) {
      parts.push('【可能相关记忆】');
      for (const h of hits) {
        parts.push('- [' + h.level + '] ' + h.content);
        seen.injected.push(h.id);
      }
    }
  }

  // 跨上下文/跨 agent 共识（关系层派生数据，存在才用）
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

/** 每轮命中注入：top-2 未见过命中 + ACP recall 融合。 */
export async function buildHitInjection(db: MemoryDb, sid: string, queryText: string, hitTopK = 2): Promise<Injection | null> {
  const rows = db.raw();
  const seen = readSeen(sid);
  const hits = recallSearch(unseen(rows, seen.injected), { query: queryText, limit: hitTopK });
  if (hits.length === 0 && !acpGraphAvailable()) return null;

  const parts: string[] = ['可能相关的记忆，仅供参考：'];
  const ids: string[] = [];
  for (const h of hits) {
    parts.push('- [' + h.level + '] ' + h.content);
    ids.push(h.id);
  }
  // ACP 融合（跨检查点）
  if (acpGraphAvailable()) {
    const acpHits = acpGraphRecall(queryText, 2);
    for (const a of acpHits) {
      parts.push('- [acp] ' + a.summary.slice(0, 120));
    }
  }
  // 跨上下文/跨 agent 共识命中：同一主题被多个会话/子代理独立提到时补充
  const cross = await crossAgentHits(queryText, 2);
  for (const c of cross) {
    const who = c.agent_kinds.length > 1 ? c.agent_kinds.join('+') : c.agent_kinds[0] ?? 'main';
    parts.push('- [cross-agent] ' + c.title + '（' + c.sources + ' 个上下文/' + who + ' 都提到）');
  }
  markInjected(sid, ids);
  return { text: parts.join('\n'), injectedIds: ids };
}

/** 压缩重注入：长期记忆快照 + 项目全景（不跑命中）。 */
export function buildReinjection(db: MemoryDb, sid: string): Injection | null {
  const rows = db.raw();
  const seen = readSeen(sid);
  clearReinjectPending(sid);
  const top = topMemories(rows);
  if (top.length === 0) return null;
  const parts: string[] = ['===== 长期记忆（压缩后重注入）====='];
  for (const r of top.slice(0, 12)) parts.push('- [' + r.level + '] ' + r.content);
  const topics = rows.filter((r) => r.level === 'topic').slice(0, 6);
  if (topics.length) {
    parts.push('【进行中话题】');
    for (const r of topics) parts.push('- ' + (r.title ?? r.content));
  }
  return { text: parts.join('\n'), injectedIds: [] };
}