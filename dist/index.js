// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/core/db.ts
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
var LEVELS = ["soul", "user", "project", "fact", "lesson", "topic", "rules", "episode"];
var GLOBAL_PROJECT = "\u5168\u5C40";
function inScope(row, scope) {
  const kind = row.scope_kind ?? "legacy";
  if (kind === "global") return true;
  if (scope.kind === "legacy") return kind === "legacy";
  return kind === scope.kind && String(row.scope_id ?? "") === String(scope.id ?? "");
}
function isLive(row) {
  return row.invalidated_at == null;
}
function genId() {
  return Date.now().toString(36) + "-" + randomUUID().replace(/-/g, "").slice(0, 12);
}
function memoryDbPath(home = process.env.DSH_HOME ?? join(homedir(), ".dsh")) {
  return join(home, "memory", "memory.db");
}
var TABLE_DDL = {
  soul: `CREATE TABLE IF NOT EXISTS soul (id TEXT PRIMARY KEY, content TEXT NOT NULL, importance INTEGER DEFAULT 1, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]', scope_kind TEXT, scope_id TEXT, source_session_id TEXT, source_episode_id TEXT, invalidated_at INTEGER, superseded_by TEXT)`,
  user: `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, content TEXT NOT NULL, importance INTEGER DEFAULT 1, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]', scope_kind TEXT, scope_id TEXT, source_session_id TEXT, source_episode_id TEXT, invalidated_at INTEGER, superseded_by TEXT)`,
  project: `CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, name TEXT NOT NULL, subcategory TEXT NOT NULL DEFAULT 'overview', content TEXT NOT NULL, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]', scope_kind TEXT, scope_id TEXT, source_session_id TEXT, source_episode_id TEXT, invalidated_at INTEGER, superseded_by TEXT)`,
  fact: `CREATE TABLE IF NOT EXISTS fact (id TEXT PRIMARY KEY, content TEXT NOT NULL, project TEXT, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]', scope_kind TEXT, scope_id TEXT, source_session_id TEXT, source_episode_id TEXT, invalidated_at INTEGER, superseded_by TEXT)`,
  lesson: `CREATE TABLE IF NOT EXISTS lesson (id TEXT PRIMARY KEY, content TEXT NOT NULL, project TEXT, corrected INTEGER DEFAULT 0, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]', scope_kind TEXT, scope_id TEXT, source_session_id TEXT, source_episode_id TEXT, invalidated_at INTEGER, superseded_by TEXT)`,
  topic: `CREATE TABLE IF NOT EXISTS topic (id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT, content TEXT, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]', scope_kind TEXT, scope_id TEXT, source_session_id TEXT, source_episode_id TEXT, invalidated_at INTEGER, superseded_by TEXT)`,
  rules: `CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, content TEXT NOT NULL, importance INTEGER DEFAULT 1, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]', scope_kind TEXT, scope_id TEXT, source_session_id TEXT, source_episode_id TEXT, invalidated_at INTEGER, superseded_by TEXT)`,
  episode: `CREATE TABLE IF NOT EXISTS episode (id TEXT PRIMARY KEY, content TEXT NOT NULL, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]', scope_kind TEXT, scope_id TEXT, source_session_id TEXT, source_episode_id TEXT, invalidated_at INTEGER, superseded_by TEXT)`
};
var COLUMNS = {
  soul: ["content", "importance", "status", "keywords", "created_at", "updated_at", "scope_kind", "scope_id", "source_session_id", "source_episode_id", "invalidated_at", "superseded_by"],
  user: ["content", "importance", "status", "keywords", "created_at", "updated_at", "scope_kind", "scope_id", "source_session_id", "source_episode_id", "invalidated_at", "superseded_by"],
  project: ["name", "subcategory", "content", "status", "keywords", "created_at", "updated_at", "scope_kind", "scope_id", "source_session_id", "source_episode_id", "invalidated_at", "superseded_by"],
  fact: ["content", "project", "status", "keywords", "created_at", "updated_at", "scope_kind", "scope_id", "source_session_id", "source_episode_id", "invalidated_at", "superseded_by"],
  lesson: ["content", "project", "corrected", "status", "keywords", "created_at", "updated_at", "scope_kind", "scope_id", "source_session_id", "source_episode_id", "invalidated_at", "superseded_by"],
  topic: ["title", "goal", "content", "status", "keywords", "created_at", "updated_at", "scope_kind", "scope_id", "source_session_id", "source_episode_id", "invalidated_at", "superseded_by"],
  rules: ["content", "importance", "status", "keywords", "created_at", "updated_at", "scope_kind", "scope_id", "source_session_id", "source_episode_id", "invalidated_at", "superseded_by"],
  episode: ["content", "status", "keywords", "created_at", "updated_at", "scope_kind", "scope_id", "source_session_id", "source_episode_id", "invalidated_at", "superseded_by"]
};
function openDb(path) {
  const dbPath = path ?? memoryDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  for (const l of LEVELS) db.exec(TABLE_DDL[l]);
  function rowToMemory(level, row) {
    if (!row) return null;
    let keywords = [];
    try {
      keywords = JSON.parse(String(row.keywords ?? "[]"));
    } catch {
      keywords = [];
    }
    return {
      id: String(row.id),
      level,
      content: String(row.content ?? row.title ?? ""),
      project: row.project != null ? String(row.project) : null,
      // A row without a scope is 'legacy', not 'global': unknown provenance must never be
      // treated as universally true (that assumption is what put 309 unlabelled rows in every
      // conversation on the machine).
      scope_kind: row.scope_kind != null ? String(row.scope_kind) : "legacy",
      scope_id: row.scope_id != null ? String(row.scope_id) : "legacy",
      source_session_id: row.source_session_id != null ? String(row.source_session_id) : null,
      source_episode_id: row.source_episode_id != null ? String(row.source_episode_id) : null,
      invalidated_at: row.invalidated_at != null ? Number(row.invalidated_at) : null,
      superseded_by: row.superseded_by != null ? String(row.superseded_by) : null,
      subcategory: row.subcategory != null ? String(row.subcategory) : null,
      title: row.title != null ? String(row.title) : null,
      goal: row.goal != null ? String(row.goal) : null,
      corrected: row.corrected != null ? Number(row.corrected) : void 0,
      importance: row.importance != null ? Number(row.importance) : void 0,
      status: row.status ?? "active",
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      keywords
    };
  }
  const api = {
    db,
    close() {
      try {
        db.close();
      } catch {
      }
    },
    create(level, data) {
      const now = Date.now();
      const id = data.id ?? genId();
      const cols = COLUMNS[level];
      const values = {
        id,
        status: "active",
        keywords: JSON.stringify(data.keywords ?? []),
        created_at: now,
        updated_at: now,
        ...data
      };
      delete values.level;
      delete values.keywords_as_arr;
      if (Array.isArray(values.keywords)) {
        values.keywords = JSON.stringify(values.keywords);
      }
      for (const key of Object.keys(values)) if (values[key] === void 0) delete values[key];
      const names = Object.keys(values).filter((k) => k === "id" || cols.includes(k));
      const sql = `INSERT INTO ${level} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
      db.prepare(sql).run(...names.map((n) => values[n]));
      return api.read(id);
    },
    read(id) {
      for (const l of LEVELS) {
        const row = db.prepare(`SELECT * FROM ${l} WHERE id = ?`).get(id);
        if (row) return rowToMemory(l, row);
      }
      return null;
    },
    update(id, patch) {
      const existing = api.read(id);
      if (!existing) return null;
      const level = existing.level;
      const cols = COLUMNS[level];
      const names = Object.keys(patch).filter((k) => cols.includes(k));
      if (names.length === 0) return existing;
      const sets = [];
      const vals = [];
      for (const n of names) {
        let v = patch[n];
        if (v === void 0) continue;
        if (n === "keywords" && Array.isArray(v)) v = JSON.stringify(v);
        sets.push(`${n} = ?`);
        vals.push(v);
      }
      sets.push("updated_at = ?");
      vals.push(Date.now());
      vals.push(id);
      db.prepare(`UPDATE ${level} SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
      return api.read(id);
    },
    remove(id) {
      const existing = api.read(id);
      if (!existing) return false;
      db.prepare(`DELETE FROM ${existing.level} WHERE id = ?`).run(id);
      return true;
    },
    list(level, opts) {
      const rows = (level ? [level] : LEVELS).flatMap(
        (l) => db.prepare(`SELECT * FROM ${l}`).all().map((r) => rowToMemory(l, r)).filter((r) => r !== null)
      );
      if (!opts) return rows;
      return rows.filter((r) => {
        if (opts.project && opts.project.length > 0) {
          const p = r.project ?? "\u5168\u5C40";
          if (!opts.project.some((x) => x === p || x === "\u5168\u5C40" || p === "\u5168\u5C40")) return false;
        }
        if (opts.status && opts.status.length > 0 && !opts.status.includes(r.status)) return false;
        if (opts.days && Date.now() - r.created_at > opts.days * 864e5) return false;
        return true;
      });
    },
    all(level) {
      return api.list(level);
    },
    raw() {
      return api.list();
    }
  };
  return api;
}

// src/core/recall.ts
function tokenize(text) {
  const s = String(text ?? "").toLowerCase();
  const words = s.match(/[a-z0-9_]+/g) ?? [];
  const cjk = s.replace(/[a-z0-9_]/g, " ").replace(/\s+/g, "");
  const bigrams = [];
  for (let i = 0; i < cjk.length - 1; i++) bigrams.push(cjk.slice(i, i + 2));
  return [...words, ...bigrams];
}
function ebbinghausDecay(createdAt, now = Date.now()) {
  const ageDays = Math.max(0, (now - createdAt) / 864e5);
  return 1 / (1 + Math.log(1 + ageDays));
}
function idf(keyword, allKeywordSets) {
  const df = allKeywordSets.filter((ks) => ks.includes(keyword)).length;
  const n = Math.max(1, allKeywordSets.length);
  return Math.log(1 + n / (1 + df));
}
function recallSearch(rows, opts) {
  const { query, limit = 10, levels = null, project = null, status = null, days = null, minScore = 0, now = Date.now() } = opts;
  if (!query) return [];
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return [];
  if (opts.scope === void 0) return [];
  let cand = opts.scope === "any" ? rows : rows.filter((r) => inScope(r, opts.scope));
  if (!opts.includeInvalidated) cand = cand.filter((r) => isLive(r));
  if (levels && levels.length > 0) cand = cand.filter((r) => levels.includes(r.level));
  if (project && project.length > 0) {
    cand = cand.filter((r) => {
      const p = r.project ?? "\u5168\u5C40";
      return project.some((x) => x === p || x === "\u5168\u5C40" || p === "\u5168\u5C40");
    });
  }
  if (status && status.length > 0) {
    cand = cand.filter((r) => status.includes(r.status));
  }
  if (days && days > 0) {
    cand = cand.filter((r) => now - r.created_at <= days * 864e5);
  }
  const allKeywordSets = cand.map((r) => r.keywords);
  const scored = [];
  for (const row of cand) {
    const rowTokens = /* @__PURE__ */ new Set([...row.keywords, ...tokenize(row.content + " " + (row.title ?? "") + " " + (row.goal ?? ""))]);
    const inter = [...qTokens].filter((t) => rowTokens.has(t));
    if (inter.length === 0) continue;
    let raw = 0;
    for (const t of inter) raw += idf(t, allKeywordSets);
    const coverage = inter.length / qTokens.size;
    const decay = ebbinghausDecay(row.created_at, now);
    const imp = (row.importance ?? 1) || 1;
    const score = raw * coverage * decay * imp;
    if (score <= 0) continue;
    scored.push({ ...row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const minS = minScore;
  return scored.filter((h) => h.score >= minS).slice(0, limit);
}
var MAX_STATEMENT_CHARS = 240;
function looksLikeDialogue(content) {
  const c = String(content ?? "");
  if (/^\s*(user|assistant|system)\s*:/i.test(c)) return true;
  return /\n\s*(user|assistant)\s*:/i.test(c);
}
function topMemories(rows) {
  return rows.filter((r) => {
    if (r.status != null && r.status !== "active") return false;
    if ((r.scope_kind ?? "legacy") !== "global") return false;
    if (!isLive(r)) return false;
    if (r.level === "soul") return true;
    if (r.level === "rules") return (r.importance ?? 1) >= 2;
    if (r.level !== "user") return false;
    const c = String(r.content ?? "");
    return c.length <= MAX_STATEMENT_CHARS && !looksLikeDialogue(c);
  });
}
function projectOverview(rows, project) {
  const p = project === "\u5168\u5C40" ? null : project;
  return rows.filter(
    (r) => (r.level === "project" || r.level === "topic") && (p === null ? true : (r.project ?? "\u5168\u5C40") === p || (r.project ?? "\u5168\u5C40") === "\u5168\u5C40")
  );
}
function hotKeywords(rows, limit = 5) {
  const freq = /* @__PURE__ */ new Map();
  for (const r of rows) {
    for (const k of r.keywords) freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k);
}

// src/core/acp.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { existsSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
function ftsPhrase(q) {
  const toks = String(q ?? "").toLowerCase().replace(/["'^*:()\[\]{}]/g, " ").split(/\s+/).filter((t) => t.length > 1).slice(0, 8);
  return toks.length ? toks.map((t) => '"' + t + '"*').join(" OR ") : '""';
}
function acpGraphPath() {
  return join2(process.env.DSH_HOME ?? join2(homedir2(), ".dsh"), "graph", "graph.db");
}
function warn(what, err) {
  console.warn("[acp-memory] " + what + ":", err instanceof Error ? err.message : String(err));
}
function acpGraphAvailable() {
  try {
    if (!existsSync(acpGraphPath())) return false;
    const db = new DatabaseSync2(acpGraphPath(), { readOnly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS c FROM checkpoints").get();
      return (row?.c ?? 0) > 0;
    } finally {
      db.close();
    }
  } catch (err) {
    warn("acpGraphAvailable probe failed", err);
    return false;
  }
}
function acpGraphRecall(query, limit = 4) {
  try {
    if (!acpGraphAvailable()) return [];
    const db = new DatabaseSync2(acpGraphPath(), { readOnly: true });
    try {
      const q = String(query ?? "").toLowerCase().trim();
      if (!q) return [];
      const matchQ = ftsPhrase(q);
      const out = [];
      try {
        const rows = db.prepare("SELECT id FROM node_fts WHERE node_fts MATCH ? LIMIT ?").all(matchQ, limit);
        for (const r of rows) {
          const cps = db.prepare("SELECT c.summary FROM checkpoints c JOIN checkpoint_nodes cn ON cn.session_id=c.session_id AND cn.seq_start=c.seq_start WHERE cn.node_id=? ORDER BY c.created_at DESC LIMIT 1").all(r.id);
          if (cps.length) out.push({ node: r.id, summary: cps[0].summary, score: 1 });
        }
      } catch (err) {
        warn("ACP entity FTS query failed (cross-session hits lost)", err);
      }
      try {
        const cps = db.prepare("SELECT session_id, seq_start, summary FROM cp_fts WHERE cp_fts MATCH ? LIMIT ?").all(matchQ, limit);
        for (const c of cps) out.push({ node: "cp:" + c.session_id + ":" + c.seq_start, summary: c.summary, score: 0.8 });
      } catch (err) {
        warn("ACP checkpoint FTS query failed (cross-session hits lost)", err);
      }
      const seen = /* @__PURE__ */ new Set();
      const dedup = [];
      for (const o of out) {
        if (!seen.has(o.node)) {
          seen.add(o.node);
          dedup.push(o);
        }
      }
      return dedup.slice(0, limit);
    } finally {
      db.close();
    }
  } catch (err) {
    warn("ACP recall failed", err);
    return [];
  }
}
function acpGraphHotEntities(limit = 5) {
  try {
    if (!acpGraphAvailable()) return [];
    const db = new DatabaseSync2(acpGraphPath(), { readOnly: true });
    try {
      return db.prepare("SELECT title AS node, mention_count AS count FROM nodes ORDER BY mention_count DESC LIMIT ?").all(limit);
    } finally {
      db.close();
    }
  } catch (err) {
    warn("ACP hot-entity query failed", err);
    return [];
  }
}

// src/core/pipeline.ts
function extractKeywords(text, limit = 8) {
  const tokens = tokenize(text);
  const freq = /* @__PURE__ */ new Map();
  for (const t of tokens) {
    if (t.length < 2) continue;
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
}
function classifyText(text) {
  const t = String(text ?? "");
  if (/教训|纠正|错误|坑|失败|注意|lesson|mistake|error|bug|失败原因/.test(t)) return "lesson";
  if (/我喜欢|我不喜欢|我希望|请务必|prefer|我喜欢|偏好/.test(t)) return "user";
  return "fact";
}
async function distill(opts) {
  const { text, project, llm = null, llmMinChars = 200 } = opts;
  const t = String(text ?? "").trim();
  if (!t) return [];
  const out = [];
  const level = classifyText(t);
  const keywords = extractKeywords(t);
  out.push({
    level,
    content: t.slice(0, 500),
    project,
    keywords
  });
  if (llm && t.length >= llmMinChars) {
    try {
      const refined = await llm(t);
      for (const r of refined) {
        if (!r.content) continue;
        out.push({
          level: r.level,
          content: r.content.slice(0, 500),
          project: r.project ?? project,
          keywords: r.keywords?.length ? r.keywords : extractKeywords(r.content),
          importance: r.importance,
          corrected: r.corrected ? 1 : 0
        });
      }
    } catch {
    }
  }
  return out;
}

// src/dsh/inject.ts
import { mkdirSync as mkdirSync2, readFileSync, writeFileSync } from "node:fs";
import { dirname as dirname2, join as join4 } from "node:path";
import { homedir as homedir4 } from "node:os";

// src/core/crossagent.ts
import { existsSync as existsSync2 } from "node:fs";
import { join as join3 } from "node:path";
import { homedir as homedir3 } from "node:os";
function dshHome() {
  return process.env.DSH_HOME ?? join3(homedir3(), ".dsh");
}
function crossAgentDbPath() {
  return process.env.DSH_NOTEMAP_DB ?? join3(dshHome(), "notemap", "graph.db");
}
function warn2(what, err) {
  console.warn("[acp-memory] " + what + ":", err instanceof Error ? err.message : String(err));
}
var sqliteWarned = false;
async function openReadOnly() {
  try {
    if (!existsSync2(crossAgentDbPath())) return null;
    const { DatabaseSync: DatabaseSync3 } = await import("node:sqlite");
    return new DatabaseSync3(crossAgentDbPath(), { readOnly: true });
  } catch (err) {
    if (!sqliteWarned) {
      sqliteWarned = true;
      warn2("cannot read the relation layer (cross-agent context disabled)", err);
    }
    return null;
  }
}
function rowToHit(row) {
  let meta = {};
  try {
    meta = JSON.parse(row.meta);
  } catch {
    meta = {};
  }
  return {
    title: String(row.title ?? ""),
    sources: Number(meta.sources ?? 0),
    agent_kinds: Array.isArray(meta.agent_kinds) ? meta.agent_kinds : [],
    mentions: Number(meta.mentions ?? 0),
    score: Number(meta.score ?? 0),
    kind: meta.kind === void 0 || meta.kind === null ? null : String(meta.kind)
  };
}
async function crossAgentAvailable() {
  const db = await openReadOnly();
  if (db === null) return false;
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE type = 'consensus'").get();
    return (row?.n ?? 0) > 0;
  } catch (err) {
    warn2("consensus probe failed", err);
    return false;
  } finally {
    try {
      db.close();
    } catch {
    }
  }
}
async function crossAgentHot(limit = 5) {
  const db = await openReadOnly();
  if (db === null) return [];
  try {
    const rows = db.prepare("SELECT title, meta FROM nodes WHERE type = 'consensus' ORDER BY json_extract(meta, '$.score') DESC LIMIT ?").all(limit);
    return rows.map(rowToHit);
  } catch (err) {
    warn2("consensus query failed", err);
    return [];
  } finally {
    try {
      db.close();
    } catch {
    }
  }
}
async function crossAgentHits(query, limit = 2) {
  const q = String(query ?? "").trim();
  if (q.length < 2) return [];
  const db = await openReadOnly();
  if (db === null) return [];
  try {
    const tokens = [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length >= 3))].slice(0, 6);
    if (tokens.length === 0) return [];
    const where = tokens.map(() => "lower(title) LIKE ?").join(" OR ");
    const rows = db.prepare(`SELECT title, meta FROM nodes WHERE type = 'consensus' AND (${where}) ORDER BY json_extract(meta, '$.score') DESC LIMIT ?`).all(...tokens.map((t) => "%" + t + "%"), limit);
    return rows.map(rowToHit);
  } catch (err) {
    warn2("consensus match failed", err);
    return [];
  } finally {
    try {
      db.close();
    } catch {
    }
  }
}

// src/dsh/inject.ts
function sessionsDir(home = process.env.DSH_HOME ?? join4(homedir4(), ".dsh")) {
  return join4(home, "memory", "sessions");
}
function sessionsFile(sid) {
  return join4(sessionsDir(), sid + ".json");
}
function readSeen(sid) {
  try {
    const p = JSON.parse(readFileSync(sessionsFile(sid), "utf8"));
    return {
      injected: Array.isArray(p.injected) ? p.injected.filter((x) => typeof x === "string") : [],
      searched: Array.isArray(p.searched) ? p.searched.filter((x) => typeof x === "string") : [],
      reinjectPending: p.reinjectPending === true
    };
  } catch {
    return { injected: [], searched: [], reinjectPending: false };
  }
}
function writeSeen(sid, seen) {
  try {
    mkdirSync2(dirname2(sessionsFile(sid)), { recursive: true });
    writeFileSync(sessionsFile(sid), JSON.stringify(seen));
  } catch (err) {
    console.warn("[acp-memory] writeSeen failed:", err instanceof Error ? err.message : String(err));
  }
}
function markInjected(sid, ids) {
  const seen = readSeen(sid);
  seen.injected = Array.from(/* @__PURE__ */ new Set([...seen.injected, ...ids]));
  writeSeen(sid, seen);
}
function markReinjectPending(sid) {
  const seen = readSeen(sid);
  seen.reinjectPending = true;
  writeSeen(sid, seen);
}
function clearReinjectPending(sid) {
  const seen = readSeen(sid);
  seen.reinjectPending = false;
  writeSeen(sid, seen);
}
function isReinjectPending(sid) {
  return readSeen(sid).reinjectPending;
}
function unseen(rows, seenIds) {
  const set = new Set(seenIds);
  return rows.filter((r) => !set.has(r.id));
}
function injectMode(env = process.env) {
  const v = String(env.DSH_ACP_MEMORY_INJECT ?? "").trim().toLowerCase();
  return v === "full" || v === "off" ? v : "scoped";
}
function memoryIndex(rows) {
  const byProject = /* @__PURE__ */ new Map();
  for (const r of rows) {
    if (r.level !== "fact" && r.level !== "lesson" && r.level !== "project") continue;
    const key = r.scope_kind === "project" ? String(r.scope_id ?? "").trim() || "(\u672A\u6807\u6CE8)" : r.scope_kind === "global" ? "(\u5168\u5C40)" : r.scope_kind === "session" ? "(\u672C\u4F1A\u8BDD)" : "(\u672A\u6807\u6CE8)";
    byProject.set(key, (byProject.get(key) ?? 0) + 1);
  }
  const parts = [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => k + " " + n);
  const topics = rows.filter((r) => r.level === "topic").length;
  const episodes = rows.filter((r) => r.level === "episode").length;
  const retired = rows.filter((r) => r.invalidated_at != null).length;
  return "\u3010\u8BB0\u5FC6\u7D22\u5F15\u3011" + parts.join(" / ") + "\uFF1B\u8BDD\u9898 " + topics + " \u6761" + (episodes ? "\uFF1B\u539F\u59CB episode " + episodes + " \u6761\uFF08\u53EF\u641C\u3001\u4E0D\u53EF\u6CE8\u5165\uFF09" : "") + (retired ? "\uFF1B\u5DF2\u5931\u6548 " + retired + " \u6761" : "") + "\u3002\u5176\u5B83\u5BF9\u8BDD\u7684\u5185\u5BB9\u4E0D\u518D\u81EA\u52A8\u6CE8\u5165\uFF0C\u9700\u8981\u65F6\u7528 memory_search / memory_project / acp_recall \u67E5\u8BE2\u3002";
}
async function buildFirstInjection(db, sid, queryText, hitTopK = 2, opts = {}) {
  const mode = opts.mode ?? injectMode();
  if (mode === "off") return null;
  const rows = db.raw();
  if (rows.length === 0) return null;
  const seen = readSeen(sid);
  const parts = ["===== \u957F\u671F\u8BB0\u5FC6 ====="];
  const top = topMemories(rows);
  if (top.length) {
    parts.push("\u3010\u5173\u4E8E\u4F60/\u7528\u6237\u3011");
    for (const r of top) {
      const when = r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : "?";
      parts.push("- [" + r.level + "] (" + when + ") " + r.content);
    }
  }
  if (mode === "scoped") {
    parts.push(memoryIndex(rows));
    parts.push("\u3010\u8BB0\u5FC6\u5BFC\u5F15\u3011\u5982\u9700\u66F4\u591A\u8BB0\u5FC6\uFF0C\u7528 memory_search / memory_project / acp_recall \u67E5\u8BE2\u3002");
    writeSeen(sid, seen);
    return { text: parts.join("\n"), injectedIds: seen.injected };
  }
  const projects = rows.filter((r) => r.level === "project");
  const topics = rows.filter((r) => r.level === "topic");
  if (projects.length || topics.length) {
    parts.push("\u3010\u8BB0\u5FC6\u5BFC\u5F15\u3011\u53EF\u7528 memory_project \u67E5\u770B\u8BE6\u60C5\uFF1A");
    for (const r of projects.slice(0, 8)) parts.push("- project: " + (r.title ?? r.content));
    for (const r of topics.slice(0, 8)) parts.push("- topic: " + (r.title ?? r.content));
  }
  if (acpGraphAvailable()) {
    const hot = acpGraphHotEntities(5);
    if (hot.length) parts.push("\u3010\u8DE8\u4F1A\u8BDD\u70ED\u5B9E\u4F53\u3011" + hot.map((h) => h.node).join(", "));
  }
  if (queryText) {
    const hits = recallSearch(unseen(rows, seen.injected), { query: queryText, limit: hitTopK, scope: { kind: "session", id: sid } });
    if (hits.length) {
      parts.push("\u3010\u53EF\u80FD\u76F8\u5173\u8BB0\u5FC6\u3011");
      for (const h of hits) {
        parts.push("- [" + h.level + "] " + h.content);
        seen.injected.push(h.id);
      }
    }
  }
  if (await crossAgentAvailable()) {
    const hot = await crossAgentHot(5);
    if (hot.length) {
      parts.push("\u3010\u8DE8\u4F1A\u8BDD/\u8DE8 agent \u5171\u8BC6\u3011" + hot.map((h) => h.title + (h.sources > 1 ? "(" + h.sources + ")" : "")).join(", "));
    }
  }
  parts.push("\u3010\u8BB0\u5FC6\u5BFC\u5F15\u3011\u5982\u9700\u66F4\u591A\u8BB0\u5FC6\uFF0C\u7528 memory_search / acp_recall \u67E5\u8BE2\u3002");
  writeSeen(sid, seen);
  return { text: parts.join("\n"), injectedIds: seen.injected };
}
async function buildHitInjection(db, sid, queryText, hitTopK = 2, opts = {}) {
  const mode = opts.mode ?? injectMode();
  if (mode !== "full") return null;
  const rows = db.raw();
  const seen = readSeen(sid);
  const hits = recallSearch(unseen(rows, seen.injected), { query: queryText, limit: hitTopK, scope: { kind: "session", id: sid } });
  if (hits.length === 0 && !acpGraphAvailable()) return null;
  const parts = ["\u53EF\u80FD\u76F8\u5173\u7684\u8BB0\u5FC6\uFF0C\u4EC5\u4F9B\u53C2\u8003\uFF1A"];
  const ids = [];
  for (const h of hits) {
    parts.push("- [" + h.level + "] " + h.content);
    ids.push(h.id);
  }
  if (acpGraphAvailable()) {
    const acpHits = acpGraphRecall(queryText, 2);
    for (const a of acpHits) {
      parts.push("- [acp] " + a.summary.slice(0, 120));
    }
  }
  const cross = await crossAgentHits(queryText, 2);
  for (const c of cross) {
    const who = c.agent_kinds.length > 1 ? c.agent_kinds.join("+") : c.agent_kinds[0] ?? "main";
    parts.push("- [cross-agent] " + c.title + "\uFF08" + c.sources + " \u4E2A\u4E0A\u4E0B\u6587/" + who + " \u90FD\u63D0\u5230\uFF09");
  }
  markInjected(sid, ids);
  return { text: parts.join("\n"), injectedIds: ids };
}
function buildReinjection(db, sid, opts = {}) {
  const mode = opts.mode ?? injectMode();
  if (mode === "off") return null;
  const rows = db.raw();
  const seen = readSeen(sid);
  clearReinjectPending(sid);
  const top = topMemories(rows);
  if (top.length === 0) return null;
  const parts = ["===== \u957F\u671F\u8BB0\u5FC6\uFF08\u538B\u7F29\u540E\u91CD\u6CE8\u5165\uFF09====="];
  for (const r of top.slice(0, 12)) parts.push("- [" + r.level + "] " + r.content);
  if (mode === "scoped") {
    const idx = memoryIndex(rows);
    if (idx) parts.push(idx);
    return { text: parts.join("\n"), injectedIds: [] };
  }
  const topics = rows.filter((r) => r.level === "topic").slice(0, 6);
  if (topics.length) {
    parts.push("\u3010\u8FDB\u884C\u4E2D\u8BDD\u9898\u3011");
    for (const r of topics) parts.push("- " + (r.title ?? r.content));
  }
  return { text: parts.join("\n"), injectedIds: [] };
}

// src/dsh/capture.ts
var DEFAULT_CAPTURE_CONFIG = {
  llmEnabled: false,
  llmMinChars: 200,
  maxDistillPerTurn: 8
};
function sessionEvents(session) {
  const s = session;
  if (s === null || s === void 0) return [];
  for (const read of [() => s.ownEvents?.(), () => s.snapshotEvents?.()]) {
    try {
      const events = read();
      if (Array.isArray(events)) return events;
    } catch {
    }
  }
  if (Array.isArray(s.log)) return s.log;
  if (Array.isArray(s.events)) return s.events;
  return [];
}
function textBlocks(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const block of value) {
    if (block === null || typeof block !== "object") continue;
    const b = block;
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
  }
  return out;
}
function scanTurnText(events) {
  if (!Array.isArray(events)) return "";
  let startIdx = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    try {
      const e = events[i];
      if (e !== null && e !== void 0 && e.type === "turn/start") {
        startIdx = i;
        break;
      }
    } catch {
    }
  }
  const texts = [];
  for (let i = startIdx; i < events.length; i++) {
    try {
      const e = events[i];
      if (e === null || e === void 0 || typeof e !== "object") continue;
      const data = e.data;
      if (e.type === "user/message") {
        const src = data?.source;
        if (src?.kind === "plugin") continue;
        const t = textBlocks(data?.content).join(" ");
        if (t) texts.push("user: " + t);
      } else if (e.type === "assistant/message") {
        const t = textBlocks(data?.message?.content).join(" ");
        if (t) texts.push("assistant: " + t);
      }
    } catch {
    }
  }
  return texts.join("\n");
}
function promotableStatement(raw) {
  const content = String(raw ?? "").replace(/^\s*(user|assistant|system)\s*:\s*/i, "").trim();
  if (!content) return null;
  if (looksLikeDialogue(content)) return null;
  if (content.length > MAX_STATEMENT_CHARS) return null;
  return content;
}
async function captureTurn(db, events, config, llm, scope) {
  const text = scanTurnText(events);
  if (!text.trim()) return 0;
  const sc = scope ?? { kind: "legacy", id: "legacy" };
  try {
    const episodeExists = db.list("episode").find((r) => r.content === text);
    const episode = episodeExists ?? db.create("episode", {
      content: text,
      keywords: extractKeywords(text),
      scope_kind: sc.kind,
      scope_id: sc.id,
      source_session_id: sc.kind === "session" ? sc.id : null
    });
    if (llm == null) return 0;
    const entries = await distill({ text, llm, llmMinChars: config.llmMinChars });
    let written = 0;
    for (const e of entries.slice(0, config.maxDistillPerTurn)) {
      const content = promotableStatement(String(e.content ?? ""));
      if (content === null) continue;
      const level = e.level === "lesson" ? "lesson" : "fact";
      const exists = db.list(level).some((r) => r.content.trim() === content);
      if (exists) continue;
      db.create(level, {
        ...e,
        content,
        scope_kind: sc.kind,
        scope_id: sc.id,
        source_session_id: sc.kind === "session" ? sc.id : null,
        source_episode_id: episode?.id ?? null
      });
      written++;
    }
    return written;
  } catch (err) {
    console.warn("[acp-memory] capture failed:", err instanceof Error ? err.message : String(err));
    return 0;
  }
}

// src/index.ts
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { homedir as homedir5 } from "node:os";
var textOut = { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: String(v) }] };
var name = "dsh-acp-memory";
var inject = ["tools"];
var LEVELS_STR = "soul | user | project | fact | lesson | topic | rules";
function fmtRow(r) {
  const head = r.title ?? (r.subcategory ? `[${r.subcategory}]` : "");
  const p = r.project && r.project !== GLOBAL_PROJECT ? ` (@${r.project})` : "";
  const corr = r.corrected ? " [\u5DF2\u7EA0\u6B63]" : "";
  return `- ${head}${p}${corr} ${r.content}`;
}
async function apply(ctx) {
  let mem = null;
  const getMem = () => mem ??= openDb();
  ctx.tools.register(defineTool({
    name: "memory_remember",
    description: "Write a memory entry to the unified seven-layer memory (soul/user/project/fact/lesson/topic/rules) at ~/.dsh/memory/memory.db. Auto-dedupes by content, merges keywords. Returns a read-back confirmation with id and keyword attribution. Rules: fact/lesson one sentence \u226460 chars; user preference quotes preserved verbatim; project requires a project name; topic requires a title.",
    parameters: {
      content: { type: "string", required: true, description: "the memory content (one sentence for fact/lesson)" },
      level: { type: "string", description: `layer: ${LEVELS_STR} (default: fact; user-preference lines auto-classify to user)` },
      project: { type: "string", description: "project name this memory belongs to (default \u5168\u5C40)" },
      subcategory: { type: "string", description: "for level=project: overview|structure|decisions|quotes|ops|todo" },
      title: { type: "string", description: "for level=topic: required title" },
      goal: { type: "string", description: "for level=topic: optional goal sentence" },
      keywords: { type: "string", description: "comma-separated keywords (auto-extracted if omitted)" },
      importance: { type: "number", description: "1-3 priority weight (default 1)" }
    },
    output: textOut,
    timeoutMs: 1e4,
    async execute(args) {
      const content = String(args?.content ?? "").trim();
      if (!content) throw new Error("content required");
      let level = String(args?.level ?? "").trim();
      if (level && !["soul", "user", "project", "fact", "lesson", "topic", "rules"].includes(level)) {
        throw new Error(`invalid level ${level}; use ${LEVELS_STR}`);
      }
      if (!level) level = /我喜欢|我希望|prefer|偏好/.test(content) ? "user" : "fact";
      const project = String(args?.project ?? "").trim() || void 0;
      const subcategory = String(args?.subcategory ?? "").trim() || void 0;
      const title = String(args?.title ?? "").trim() || void 0;
      const goal = String(args?.goal ?? "").trim() || void 0;
      const importance = Number(args?.importance ?? 1) || 1;
      let keywords = String(args?.keywords ?? "").split(",").map((k) => k.trim()).filter(Boolean);
      if (keywords.length === 0) keywords = extractKeywords(content);
      const db = getMem();
      const scope = level === "soul" || level === "user" || level === "rules" ? { kind: "global", id: "" } : project ? { kind: "project", id: project } : { kind: "legacy", id: "legacy" };
      const existing = db.list(level).find((r) => r.content.trim() === content);
      let row;
      if (existing) {
        const merged = Array.from(/* @__PURE__ */ new Set([...existing.keywords, ...keywords]));
        row = db.update(existing.id, { keywords: merged, project, subcategory, title, goal, importance, scope_kind: scope.kind, scope_id: scope.id });
      } else {
        row = db.create(level, {
          content,
          project: project ?? (level === "project" ? GLOBAL_PROJECT : void 0),
          scope_kind: scope.kind,
          scope_id: scope.id,
          subcategory,
          title,
          goal,
          importance,
          keywords
        });
      }
      const kw = row.keywords.join(", ");
      return `saved [${row.level}] ${row.id} (project: ${row.project ?? GLOBAL_PROJECT}, keywords: ${kw})
${row.content}`;
    }
  }));
  ctx.tools.register(defineTool({
    name: "memory_invalidate",
    description: "Retire a memory row: mark it no longer true (invalidated_at) and optionally name the row that superseded it. Retired rows stop coming back from memory_search and can never be injected; pass includeInvalidated to memory_search to audit them. Use this instead of deleting when a fact was true once but is not any more.",
    parameters: {
      id: { type: "string", required: true, description: "memory id to retire" },
      superseded_by: { type: "string", description: "id of the row that replaces it (optional)" }
    },
    output: textOut,
    timeoutMs: 1e4,
    async execute(args) {
      const id = String(args?.id ?? "").trim();
      if (!id) throw new Error("id required");
      const db = getMem();
      const row = db.read(id);
      if (!row) throw new Error("no memory with id " + id);
      const updated = db.update(id, { invalidated_at: Date.now(), superseded_by: String(args?.superseded_by ?? "").trim() || null });
      return "retired [" + row.level + "] " + id + (updated?.superseded_by ? " (superseded by " + updated.superseded_by + ")" : "") + "\n  " + row.content.slice(0, 200);
    }
  }));
  ctx.tools.register(defineTool({
    name: "memory_search",
    description: "Search the seven-layer memory with keyword\xD7BM25\xD7recency-decay scoring. Supports level/project/status/days filters. Returns top hits with id, level, content, project, relative age, keywords.",
    parameters: {
      query: { type: "string", required: true, description: "search keywords (Chinese bigram + English tokens)" },
      level: { type: "string", description: `filter by layer: ${LEVELS_STR} | episode (episode = the raw record of a turn; searchable, never auto-injected, never promoted)` },
      project: { type: "string", description: "filter by project name (comma-separated = OR); \u5168\u5C40 always covers" },
      status: { type: "string", description: "filter by status: active|archived|stale" },
      days: { type: "number", description: "only entries created within N days" },
      limit: { type: "number", description: "max results (default 10)" },
      includeInvalidated: { type: "boolean", description: "also return rows something explicitly retired (default false; for auditing)" }
    },
    output: textOut,
    timeoutMs: 1e4,
    async execute(args) {
      const query = String(args?.query ?? "").trim();
      if (!query) throw new Error("query required");
      const db = getMem();
      const hits = recallSearch(db.raw(), {
        query,
        scope: "any",
        limit: Number(args?.limit ?? 10) || 10,
        levels: args?.level ? [String(args.level)] : null,
        project: args?.project ? String(args.project).split(",").map((s) => s.trim()) : null,
        days: args?.days ? Number(args.days) : null,
        includeInvalidated: args?.includeInvalidated === true
      });
      if (hits.length === 0) return "no memory hit";
      const scopeTag = (h) => h.scope_kind === "global" ? "global" : (h.scope_kind ?? "legacy") + ":" + (h.scope_id ?? "legacy");
      const provTag = (h) => {
        const bits = [];
        if (h.source_session_id) bits.push("src=" + String(h.source_session_id).slice(0, 8));
        if (h.source_episode_id) bits.push("ep=" + String(h.source_episode_id).slice(0, 8));
        if (h.invalidated_at) bits.push("RETIRED " + ageLabel(h.invalidated_at) + (h.superseded_by ? " by " + String(h.superseded_by).slice(0, 8) : ""));
        return bits.length ? " " + bits.join(" ") : "";
      };
      return hits.map((h) => `[${h.level}] ${h.id} @${scopeTag(h)}${provTag(h)} (score ${h.score.toFixed(3)}, ${ageLabel(h.created_at)})
  ${fmtRow(h)}`).join("\n");
    }
  }));
  ctx.tools.register(defineTool({
    name: "memory_read",
    description: "Read a single memory entry by id (returned by memory_search/remember).",
    parameters: { id: { type: "string", required: true, description: "memory id" } },
    output: textOut,
    timeoutMs: 1e4,
    async execute(args) {
      const id = String(args?.id ?? "").trim();
      if (!id) throw new Error("id required");
      const db = getMem();
      const row = db.read(id);
      if (!row) return `no memory ${id}`;
      return JSON.stringify({
        id: row.id,
        level: row.level,
        content: row.content,
        project: row.project,
        subcategory: row.subcategory,
        title: row.title,
        goal: row.goal,
        corrected: row.corrected,
        importance: row.importance,
        status: row.status,
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
        keywords: row.keywords
      }, null, 2);
    }
  }));
  ctx.tools.register(defineTool({
    name: "memory_update",
    description: "Update a memory entry (content/project/subcategory/title/goal/importance/status/keywords).",
    parameters: {
      id: { type: "string", required: true, description: "memory id" },
      content: { type: "string", description: "new content" },
      project: { type: "string", description: "new project" },
      subcategory: { type: "string", description: "new subcategory" },
      title: { type: "string", description: "new title (topic)" },
      goal: { type: "string", description: "new goal (topic)" },
      importance: { type: "number", description: "new importance" },
      status: { type: "string", description: "active|archived|stale" },
      keywords: { type: "string", description: "comma-separated new keywords" }
    },
    output: textOut,
    timeoutMs: 1e4,
    async execute(args) {
      const id = String(args?.id ?? "").trim();
      if (!id) throw new Error("id required");
      const db = getMem();
      const patch = {};
      if (args.content != null) patch.content = String(args.content);
      if (args.project != null) patch.project = String(args.project);
      if (args.subcategory != null) patch.subcategory = String(args.subcategory);
      if (args.title != null) patch.title = String(args.title);
      if (args.goal != null) patch.goal = String(args.goal);
      if (args.importance != null) patch.importance = Number(args.importance);
      if (args.status != null) patch.status = String(args.status);
      if (args.keywords != null) patch.keywords = String(args.keywords).split(",").map((k) => k.trim()).filter(Boolean);
      const row = db.update(id, patch);
      if (!row) return `no memory ${id}`;
      return `updated ${id} [${row.level}]: ${row.content}`;
    }
  }));
  ctx.tools.register(defineTool({
    name: "memory_project",
    description: "Project panorama: all project/topic entries for a project, grouped by subcategory (Scene Navigation). project parameter required \u2014 which project do you want to see?",
    parameters: { project: { type: "string", required: true, description: "project name (or \u5168\u5C40)" } },
    output: textOut,
    timeoutMs: 1e4,
    async execute(args) {
      const project = String(args?.project ?? "").trim();
      if (!project) throw new Error("project required");
      const db = getMem();
      const rows = projectOverview(db.raw(), project);
      if (rows.length === 0) return `no memory for project ${project}`;
      const groups = /* @__PURE__ */ new Map();
      for (const r of rows) {
        const k = r.level === "topic" ? "topics" : r.subcategory ?? "overview";
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      const out = [`## project ${project}`];
      for (const [k, items] of groups) {
        out.push(`### ${k}`);
        for (const r of items) out.push(fmtRow(r));
      }
      return out.join("\n");
    }
  }));
  ctx.tools.register(defineTool({
    name: "memory_find_similar",
    description: "Find similar existing memory entries (dedupe/conflict check) by keyword overlap.",
    parameters: {
      query: { type: "string", required: true, description: "text to find similar entries for" },
      limit: { type: "number", description: "max results (default 5)" }
    },
    output: textOut,
    timeoutMs: 1e4,
    async execute(args) {
      const query = String(args?.query ?? "").trim();
      if (!query) throw new Error("query required");
      const db = getMem();
      const hits = recallSearch(db.raw(), { query, scope: "any", limit: Number(args?.limit ?? 5) || 5 });
      if (hits.length === 0) return "no similar memory";
      return hits.map((h) => fmtRow(h)).join("\n");
    }
  }));
  ctx.tools.register(defineTool({
    name: "memory_status",
    description: "Memory store status: per-layer counts + ACP graph availability.",
    parameters: {},
    output: textOut,
    timeoutMs: 1e4,
    async execute() {
      const db = getMem();
      const rows = db.raw();
      const byLevel = /* @__PURE__ */ new Map();
      for (const r of rows) byLevel.set(r.level, (byLevel.get(r.level) ?? 0) + 1);
      const parts = ["## memory store", `db: ${process.env.DSH_HOME ?? homedir5()}/.dsh/memory/memory.db`, `total: ${rows.length}`];
      for (const l of ["soul", "user", "project", "fact", "lesson", "topic", "rules"]) {
        parts.push(`  ${l}: ${byLevel.get(l) ?? 0}`);
      }
      const hot = hotKeywords(rows, 5);
      if (hot.length) parts.push("hot keywords: " + hot.join(", "));
      parts.push("acp graph available: " + acpGraphAvailable());
      if (acpGraphAvailable()) {
        const ents = acpGraphHotEntities(5);
        if (ents.length) parts.push("acp hot entities: " + ents.map((e) => e.node).join(", "));
      }
      return parts.join("\n");
    }
  }));
  ctx.tools.register(defineTool({
    name: "acp_recall",
    description: "Cross-checkpoint memory recall: search the ACP graph (~/.dsh/graph/graph.db) plus the seven-layer memory, returning memory the linear surface cannot see (compacted-away content). Use when the user references earlier sessions, past decisions, or shared context.",
    parameters: {
      query: { type: "string", required: true, description: "what to recall (topic/entity/decision)" },
      limit: { type: "number", description: "max results (default 4)" },
      includeLocal: { type: "boolean", description: "also search seven-layer memory (default true)" }
    },
    output: textOut,
    timeoutMs: 15e3,
    async execute(args) {
      const query = String(args?.query ?? "").trim();
      if (!query) throw new Error("query required");
      const out = ["## ACP recall: " + query];
      if (acpGraphAvailable()) {
        const hits = acpGraphRecall(query, Number(args?.limit ?? 4) || 4);
        if (hits.length) {
          out.push("### graph (compacted sessions)");
          for (const h of hits) out.push(`- ${h.node}: ${h.summary.slice(0, 200)}`);
        }
      } else {
        out.push("(acp graph not available \u2014 install dsh-session-handoff)");
      }
      if (args?.includeLocal !== false) {
        const db = getMem();
        const local = recallSearch(db.raw(), { query, scope: "any", limit: 4 });
        if (local.length) {
          out.push("### local memory");
          for (const h of local) out.push(fmtRow(h));
        }
      }
      return out.join("\n");
    }
  }));
  const captureConfig = { ...DEFAULT_CAPTURE_CONFIG };
  const firstUserHandled = /* @__PURE__ */ new Set();
  ctx.on("session/event", (session, event) => {
    try {
      const sid = String(session?.id ?? "");
      if (!sid) return;
      const t = String(event?.type ?? "");
      if (t === "compaction/end") {
        markReinjectPending(sid);
        ctx.logger?.info("acp-memory: compaction finished, re-injection armed");
      } else if (t === "turn/end") {
        void (async () => {
          try {
            const db = getMem();
            const events = sessionEvents(session);
            if (events.length === 0) {
              console.warn("[acp-memory] turn/end with no readable events - capture skipped (session.events does not exist; use ownEvents()/log)");
              return;
            }
            const written = await captureTurn(db, events, captureConfig, null, { kind: "session", id: sid });
            if (written > 0) ctx.logger?.info("acp-memory: captured " + written + " memory entries");
          } catch (err) {
            console.warn("[acp-memory] capture hook failed:", err instanceof Error ? err.message : String(err));
          }
        })();
      }
    } catch (err) {
      console.warn("[acp-memory] session/event listener failed:", err instanceof Error ? err.message : String(err));
    }
  });
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    try {
      const decision = await next();
      if (decision === void 0 || decision.kind !== "enter" || signal?.aborted) return decision;
      if (!decision.messages || decision.messages.length === 0) return decision;
      if (agent?.session?.header?.origin === "subagent") return decision;
      const sid = String(agent?.session?.id ?? "");
      if (!sid) return decision;
      const userMsgs = decision.messages.filter((m) => m?.source?.kind === "user");
      if (userMsgs.length === 0) return decision;
      const lastUser = userMsgs[userMsgs.length - 1];
      if (isReinjectPending(sid)) {
        const db2 = getMem();
        const reinj = buildReinjection(db2, sid);
        if (reinj !== null) {
          const rewritten = [...decision.messages];
          rewritten.splice(rewritten.indexOf(lastUser), 0, createUserMessage({
            content: [{ type: "text", text: reinj.text }],
            source: { kind: "plugin", plugin: "dsh-acp-memory", form: "snapshot", sections: [] }
          }));
          return { ...decision, messages: rewritten };
        }
        return decision;
      }
      if (!firstUserHandled.has(sid)) {
        firstUserHandled.add(sid);
        const priorUser = (agent.session.events ?? []).filter((e) => e?.type === "user/message" && e?.data?.source?.kind === "user").length;
        if (priorUser === 0) {
          const db2 = getMem();
          const firstText = String(lastUser?.content?.[0]?.text ?? "");
          const inj = await buildFirstInjection(db2, sid, firstText);
          if (inj !== null) {
            const rewritten = [...decision.messages];
            rewritten.splice(rewritten.indexOf(lastUser), 0, createUserMessage({
              content: [{ type: "text", text: inj.text }],
              source: { kind: "plugin", plugin: "dsh-acp-memory", form: "snapshot", sections: [] }
            }));
            return { ...decision, messages: rewritten };
          }
        }
        return decision;
      }
      const db = getMem();
      const queryText = String(lastUser?.content?.[0]?.text ?? "");
      if (queryText) {
        const hit = await buildHitInjection(db, sid, queryText, 2);
        if (hit !== null) {
          const rewritten = [...decision.messages];
          rewritten.splice(rewritten.indexOf(lastUser), 0, createUserMessage({
            content: [{ type: "text", text: hit.text }],
            source: { kind: "plugin", plugin: "dsh-acp-memory", form: "snapshot", sections: [] }
          }));
          return { ...decision, messages: rewritten };
        }
      }
      return decision;
    } catch {
      return void 0;
    }
  });
  return () => {
    try {
      mem?.close();
    } catch {
    }
  };
}
function ageLabel(ms) {
  const diff = Date.now() - ms;
  if (diff < 6e4) return "just now";
  if (diff < 36e5) return Math.floor(diff / 6e4) + "m ago";
  if (diff < 864e5) return Math.floor(diff / 36e5) + "h ago";
  if (diff < 30 * 864e5) return Math.floor(diff / 864e5) + "d ago";
  return new Date(ms).toISOString().slice(0, 10);
}
export {
  apply,
  inject,
  name
};
