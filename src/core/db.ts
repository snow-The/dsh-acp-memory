/**
 * acp-memory — core/db.ts（核心引擎：memory.db 七层记忆 + CRUD）
 *
 * 零 DSH 依赖（node:sqlite + node builtins），可独立测试/复用/日后 server 化。
 * 七层表（meow-memory 设计）：soul/user/project/fact/lesson/topic/rules。
 * id = 时间前缀（base36 毫秒 + 随机后缀，36 字符）：id 排序即创建顺序。
 * 全局标记：project.name = '全局'（跨项目共享）。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

export type Level = 'soul' | 'user' | 'project' | 'fact' | 'lesson' | 'topic' | 'rules';
export type Status = 'active' | 'archived' | 'stale';

export const LEVELS: readonly Level[] = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'];

/** project 子类（meow 拍板）：目标概述/项目结构/技术决策/用户原话/部署与数据/进行中。 */
export const PROJECT_SUBCATEGORIES = ['overview', 'structure', 'decisions', 'quotes', 'ops', 'todo'] as const;
export type ProjectSubcategory = (typeof PROJECT_SUBCATEGORIES)[number];

/** 全局标记（跨项目共享）。 */
export const GLOBAL_PROJECT = '全局';

export interface MemoryRow {
  id: string;
  level: Level;
  content: string;
  project?: string | null;
  subcategory?: string | null;
  title?: string | null;
  goal?: string | null;
  corrected?: number;
  importance?: number;
  status: Status;
  created_at: number;
  updated_at: number;
  keywords: string[];
}

/** 生成时间前缀 id（base36 毫秒 + 随机后缀，可排序）。 */
export function genId(): string {
  return Date.now().toString(36) + '-' + randomUUID().replace(/-/g, '').slice(0, 12);
}

/** memory.db 路径（全局，跨工作区共享）。 */
export function memoryDbPath(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')): string {
  return join(home, 'memory', 'memory.db');
}

export interface MemoryDb {
  db: DatabaseSync;
  close(): void;
  // CRUD
  create(level: Level, data: Partial<MemoryRow>): MemoryRow;
  read(id: string): MemoryRow | null;
  update(id: string, patch: Partial<MemoryRow>): MemoryRow | null;
  remove(id: string): boolean;
  list(level?: Level, opts?: { project?: string[] | null; status?: string[] | null; days?: number | null }): MemoryRow[];
  all(level?: Level): MemoryRow[];
  /** 全文/关键词检索（BM25 由 recall.ts 负责；这里给原始列表）。 */
  raw(): MemoryRow[];
}

const TABLE_DDL: Record<Level, string> = {
  soul: `CREATE TABLE IF NOT EXISTS soul (id TEXT PRIMARY KEY, content TEXT NOT NULL, importance INTEGER DEFAULT 1, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]')`,
  user: `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, content TEXT NOT NULL, importance INTEGER DEFAULT 1, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]')`,
  project: `CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, name TEXT NOT NULL, subcategory TEXT NOT NULL DEFAULT 'overview', content TEXT NOT NULL, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]')`,
  fact: `CREATE TABLE IF NOT EXISTS fact (id TEXT PRIMARY KEY, content TEXT NOT NULL, project TEXT, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]')`,
  lesson: `CREATE TABLE IF NOT EXISTS lesson (id TEXT PRIMARY KEY, content TEXT NOT NULL, project TEXT, corrected INTEGER DEFAULT 0, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]')`,
  topic: `CREATE TABLE IF NOT EXISTS topic (id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT, content TEXT, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]')`,
  rules: `CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, content TEXT NOT NULL, importance INTEGER DEFAULT 1, status TEXT DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, keywords TEXT DEFAULT '[]')`,
};

/** 各层可写列（防止注入任意列）。 */
const COLUMNS: Record<Level, string[]> = {
  soul: ['content', 'importance', 'status', 'keywords', 'created_at', 'updated_at'],
  user: ['content', 'importance', 'status', 'keywords', 'created_at', 'updated_at'],
  project: ['name', 'subcategory', 'content', 'status', 'keywords', 'created_at', 'updated_at'],
  fact: ['content', 'project', 'status', 'keywords', 'created_at', 'updated_at'],
  lesson: ['content', 'project', 'corrected', 'status', 'keywords', 'created_at', 'updated_at'],
  topic: ['title', 'goal', 'content', 'status', 'keywords', 'created_at', 'updated_at'],
  rules: ['content', 'importance', 'status', 'keywords', 'created_at', 'updated_at'],
};

export function openDb(path?: string): MemoryDb {
  const dbPath = path ?? memoryDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  for (const l of LEVELS) db.exec(TABLE_DDL[l]);

  function rowToMemory(level: Level, row: Record<string, unknown> | undefined): MemoryRow | null {
    if (!row) return null;
    let keywords: string[] = [];
    try { keywords = JSON.parse(String(row.keywords ?? '[]')); } catch { keywords = []; }
    return {
      id: String(row.id),
      level,
      content: String(row.content ?? row.title ?? ''),
      project: row.project != null ? String(row.project) : null,
      subcategory: row.subcategory != null ? String(row.subcategory) : null,
      title: row.title != null ? String(row.title) : null,
      goal: row.goal != null ? String(row.goal) : null,
      corrected: row.corrected != null ? Number(row.corrected) : undefined,
      importance: row.importance != null ? Number(row.importance) : undefined,
      status: (row.status as Status) ?? 'active',
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      keywords,
    };
  }

  const api: MemoryDb = {
    db,
    close() { try { db.close(); } catch { /* */ } },

    create(level, data): MemoryRow {
      const now = Date.now();
      const id = data.id ?? genId();
      const cols = COLUMNS[level];
      const values: Record<string, unknown> = {
        id,
        status: 'active',
        keywords: JSON.stringify(data.keywords ?? []),
        created_at: now,
        updated_at: now,
        ...data,
      };
      delete (values as Record<string, unknown>).level;
      delete (values as Record<string, unknown>).keywords_as_arr;
      if (Array.isArray((values as Record<string, unknown>).keywords)) {
        (values as Record<string, unknown>).keywords = JSON.stringify(values.keywords);
      }
      // node:sqlite cannot bind `undefined` - it throws "Provided value cannot be bound
      // to SQLite parameter N". A caller that omits an optional field (the capture path
      // has no project) must fall back to the column default, not blow up the write.
      for (const key of Object.keys(values)) if (values[key] === undefined) delete values[key];
      const names = Object.keys(values).filter((k) => k === 'id' || cols.includes(k));
      const sql = `INSERT INTO ${level} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
      db.prepare(sql).run(...names.map((n) => values[n] as string | number | null));
      return api.read(id) as MemoryRow;
    },

    read(id) {
      for (const l of LEVELS) {
        const row = db.prepare(`SELECT * FROM ${l} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
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
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const n of names) {
        let v = patch[n as keyof MemoryRow];
        if (v === undefined) continue;                    // never bind undefined
        if (n === 'keywords' && Array.isArray(v)) v = JSON.stringify(v);
        sets.push(`${n} = ?`);
        vals.push(v);
      }
      sets.push('updated_at = ?');
      vals.push(Date.now());
      vals.push(id);
      db.prepare(`UPDATE ${level} SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as (string | number | null)[]));
      return api.read(id);
    },

    remove(id) {
      const existing = api.read(id);
      if (!existing) return false;
      db.prepare(`DELETE FROM ${existing.level} WHERE id = ?`).run(id);
      return true;
    },

    list(level, opts) {
      const rows = (level ? [level] : LEVELS).flatMap((l) =>
        (db.prepare(`SELECT * FROM ${l}`).all() as Record<string, unknown>[])
          .map((r) => rowToMemory(l, r))
          .filter((r): r is MemoryRow => r !== null),
      );
      if (!opts) return rows;
      return rows.filter((r) => {
        if (opts.project && opts.project.length > 0) {
          const p = r.project ?? '全局';
          if (!opts.project.some((x) => x === p || x === '全局' || p === '全局')) return false;
        }
        if (opts.status && opts.status.length > 0 && !opts.status.includes(r.status)) return false;
        if (opts.days && Date.now() - r.created_at > opts.days * 86_400_000) return false;
        return true;
      });
    },

    all(level) { return api.list(level); },

    raw() { return api.list(); },
  };

  return api;
}

export type { DatabaseSync };