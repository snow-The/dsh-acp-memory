/**
 * acp-memory — core/acp.ts（ACP graph 数据层依赖）
 *
 * dsh-session-handoff 的 acp_graph (~/.dsh/graph/graph.db) 是跨会话长期记忆的
 * 权威图。acp-memory 通过**数据层依赖**（直接读 graph.db SQLite，research-lab
 * 已验证模式）复用 ACP 图谱：跨检查点实体/摘要检索。无 ACP 图时返回 []，
 * 完全降级（不破坏核心功能）。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** FTS5 phrase builder: quotes every token so user text (paths like C:\\x, "*", ":", quotes)
 * can never be parsed as column filters or operators. Falls back to a harmless empty phrase. */
function ftsPhrase(q: unknown): string {
  const toks = String(q ?? '').toLowerCase().replace(/["'^*:()\[\]{}]/g, ' ').split(/\s+/).filter((t) => t.length > 1).slice(0, 8);
  return toks.length ? toks.map((t) => '"' + t + '"').join(' OR ') : '""';
}

export function acpGraphPath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'graph', 'graph.db');
}

/** ACP 图可用性：graph.db 存在 且 checkpoints 非空。 */
/**
 * Every fallback below keeps working when the ACP graph is absent (that is by design),
 * but a fallback that cannot be told apart from "there is simply no data" is how a
 * week-long silent outage happened elsewhere in this plugin. Report the failure once
 * per call - it only fires on the error path, so a healthy install stays quiet.
 */
function warn(what: string, err: unknown): void {
  console.warn('[acp-memory] ' + what + ':', err instanceof Error ? err.message : String(err));
}

export function acpGraphAvailable(): boolean {
  try {
    if (!existsSync(acpGraphPath())) return false;
    const db = new DatabaseSync(acpGraphPath(), { readOnly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS c FROM checkpoints').get() as { c: number };
      return (row?.c ?? 0) > 0;
    } finally { db.close(); }
  } catch (err) { warn('acpGraphAvailable probe failed', err); return false; }
}

export interface AcpRecallHit { node: string; summary: string; score: number; }

/** 查询 ACP 图，返回跨会话 checkpoint 命中（FTS5 实体 + 摘要）。 */
export function acpGraphRecall(query: string, limit = 4): AcpRecallHit[] {
  try {
    if (!acpGraphAvailable()) return [];
    const db = new DatabaseSync(acpGraphPath(), { readOnly: true });
    try {
      const q = String(query ?? '').toLowerCase().trim();
      if (!q) return [];
      const matchQ = ftsPhrase(q);
      const out: AcpRecallHit[] = [];
      // 1) 实体命中 → 带出它所在的最新 checkpoint
      try {
        const rows = db.prepare('SELECT id FROM node_fts WHERE node_fts MATCH ? LIMIT ?').all(matchQ, limit) as { id: string }[];
        for (const r of rows) {
          const cps = db.prepare('SELECT c.summary FROM checkpoints c JOIN checkpoint_nodes cn ON cn.session_id=c.session_id AND cn.seq_start=c.seq_start WHERE cn.node_id=? ORDER BY c.created_at DESC LIMIT 1').all(r.id) as { summary: string }[];
          if (cps.length) out.push({ node: r.id, summary: cps[0].summary, score: 1 });
        }
      } catch (err) { warn('ACP entity FTS query failed (cross-session hits lost)', err); }
      // 2) checkpoint 摘要命中
      try {
        const cps = db.prepare('SELECT session_id, seq_start, summary FROM cp_fts WHERE cp_fts MATCH ? LIMIT ?').all(matchQ, limit) as { session_id: string; seq_start: number; summary: string }[];
        for (const c of cps) out.push({ node: 'cp:' + c.session_id + ':' + c.seq_start, summary: c.summary, score: 0.8 });
      } catch (err) { warn('ACP checkpoint FTS query failed (cross-session hits lost)', err); }
      // 去重
      const seen = new Set<string>();
      const dedup: AcpRecallHit[] = [];
      for (const o of out) { if (!seen.has(o.node)) { seen.add(o.node); dedup.push(o); } }
      return dedup.slice(0, limit);
    } finally { db.close(); }
  } catch (err) { warn('ACP recall failed', err); return []; }
}

/** 热实体（ACP 图的高频节点，供首轮注入引导）。 */
export function acpGraphHotEntities(limit = 5): { node: string; count: number }[] {
  try {
    if (!acpGraphAvailable()) return [];
    const db = new DatabaseSync(acpGraphPath(), { readOnly: true });
    try {
      return db.prepare('SELECT title AS node, mention_count AS count FROM nodes ORDER BY mention_count DESC LIMIT ?').all(limit) as { node: string; count: number }[];
    } finally { db.close(); }
  } catch (err) { warn('ACP hot-entity query failed', err); return []; }
}
