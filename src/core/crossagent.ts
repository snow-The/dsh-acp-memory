/**
 * acp-memory — cross-agent bridge to the relation layer (derived data, optional).
 *
 * Owner's layering: handoff COLLECTS, memory PROCESSES/USES, notemap RELATES.
 * notemap publishes what several contexts/agents independently agreed on as
 * 'consensus' nodes in its own store. Memory reads those rows read-only when the store
 * exists.
 *
 * Why this is not a dependency cycle:
 *   - it is a DATA read of DERIVED output, never a code import;
 *   - the authority stays where it was: memory's seven layers are the source of truth,
 *     handoff's graph is the collected record, and notemap's network is rebuildable -
 *     deleting it costs nothing and this bridge simply reports "unavailable".
 *
 * A silent fallback here would be indistinguishable from "no cross-agent agreement
 * yet", so the error path logs.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface CrossAgentHit {
  title: string;
  sources: number;
  agent_kinds: string[];
  mentions: number;
  score: number;
  kind: string | null;
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}
export function crossAgentDbPath(): string {
  return process.env.DSH_NOTEMAP_DB ?? join(dshHome(), 'notemap', 'graph.db');
}

function warn(what: string, err: unknown): void {
  console.warn('[acp-memory] ' + what + ':', err instanceof Error ? err.message : String(err));
}

let sqliteWarned = false;
async function openReadOnly(): Promise<any | null> {
  try {
    if (!existsSync(crossAgentDbPath())) return null;          // absent by design
    const { DatabaseSync } = (await import('node:sqlite')) as any;
    return new DatabaseSync(crossAgentDbPath(), { readOnly: true });
  } catch (err) {
    if (!sqliteWarned) { sqliteWarned = true; warn('cannot read the relation layer (cross-agent context disabled)', err); }
    return null;
  }
}

function rowToHit(row: { title: string; meta: string }): CrossAgentHit {
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(row.meta) as Record<string, unknown>; } catch { meta = {}; }
  return {
    title: String(row.title ?? ''),
    sources: Number(meta.sources ?? 0),
    agent_kinds: Array.isArray(meta.agent_kinds) ? (meta.agent_kinds as string[]) : [],
    mentions: Number(meta.mentions ?? 0),
    score: Number(meta.score ?? 0),
    kind: meta.kind === undefined || meta.kind === null ? null : String(meta.kind),
  };
}

/** Is the relation layer present and carrying a consensus digest? */
export async function crossAgentAvailable(): Promise<boolean> {
  const db = await openReadOnly();
  if (db === null) return false;
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE type = 'consensus'").get() as { n?: number } | undefined;
    return (row?.n ?? 0) > 0;
  } catch (err) { warn('consensus probe failed', err); return false; } finally { try { db.close(); } catch { /* best effort */ } }
}

/** The strongest cross-context/cross-agent agreements overall. */
export async function crossAgentHot(limit = 5): Promise<CrossAgentHit[]> {
  const db = await openReadOnly();
  if (db === null) return [];
  try {
    const rows = db.prepare("SELECT title, meta FROM nodes WHERE type = 'consensus' ORDER BY json_extract(meta, '$.score') DESC LIMIT ?").all(limit) as { title: string; meta: string }[];
    return rows.map(rowToHit);
  } catch (err) { warn('consensus query failed', err); return []; } finally { try { db.close(); } catch { /* best effort */ } }
}

/** Agreements whose subject matches the current text. */
export async function crossAgentHits(query: string, limit = 2): Promise<CrossAgentHit[]> {
  const q = String(query ?? '').trim();
  if (q.length < 2) return [];
  const db = await openReadOnly();
  if (db === null) return [];
  try {
    // tokens of the query, matched against the digest titles; json order by score
    const tokens = [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length >= 3))].slice(0, 6);
    if (tokens.length === 0) return [];
    const where = tokens.map(() => 'lower(title) LIKE ?').join(' OR ');
    const rows = db.prepare(`SELECT title, meta FROM nodes WHERE type = 'consensus' AND (${where}) ORDER BY json_extract(meta, '$.score') DESC LIMIT ?`)
      .all(...tokens.map((t) => '%' + t + '%'), limit) as { title: string; meta: string }[];
    return rows.map(rowToHit);
  } catch (err) { warn('consensus match failed', err); return []; } finally { try { db.close(); } catch { /* best effort */ } }
}
