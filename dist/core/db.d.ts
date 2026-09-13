import { DatabaseSync } from 'node:sqlite';
export type Level = 'soul' | 'user' | 'project' | 'fact' | 'lesson' | 'topic' | 'rules' | 'episode';
export type Status = 'active' | 'archived' | 'stale';
export declare const LEVELS: readonly Level[];
/**
 * The semantic layers: what the agent may assert and what may be injected. 'episode' is
 * deliberately NOT in this set -- it is the raw record of what was said, never promoted to a
 * stronger claim, and never injected.
 */
export declare const SEMANTIC_LEVELS: readonly Level[];
/** project 子类（meow 拍板）：目标概述/项目结构/技术决策/用户原话/部署与数据/进行中。 */
export declare const PROJECT_SUBCATEGORIES: readonly ['overview', 'structure', 'decisions', 'quotes', 'ops', 'todo'];
export type ProjectSubcategory = (typeof PROJECT_SUBCATEGORIES)[number];
/** 全局标记（跨项目共享）。 */
export declare const GLOBAL_PROJECT = "\u5168\u5C40";
/**
 * 作用域。写的时候必填，读的时候必带——这是 mem0（search 缺 user_id/agent_id/run_id 直接抛异常）/
 * Zep（user+thread 分区）/ LangGraph（namespace 元组）的共同做法，也是我们原先缺的那一层：
 * 只有可空自由文本 project、召回不校验，于是"跨域"是默认情况（320 行里 309 行 project 为空）。
 */
export type ScopeKind = 'global' | 'session' | 'project' | 'legacy';
export interface Scope {
    kind: ScopeKind;
    id: string;
}
/** 身份层（soul/user/rules）天然全局；其余必须带域。 */
export declare const GLOBAL_SCOPE: Scope;
export declare const LEGACY_SCOPE: Scope;
/** 一行是否落在给定作用域内。legacy 永不自动命中——只能显式点名查。 */
export declare function inScope(row: {
    scope_kind?: string | null;
    scope_id?: string | null;
}, scope: Scope): boolean;
/**
 * Provenance of a row. All four are optional so a caller that omits them falls back to the column
 * default (node:sqlite refuses to bind undefined).
 * - source_session_id: which conversation wrote it (null = manual write or unknown)
 * - source_episode_id: the raw episode a promoted statement was derived from
 * - invalidated_at:    when it stopped being true (null = live). NEVER inferred -- only an explicit
 *                      retraction, or a supersede, sets it. Graphiti invalidates graph-wide with an
 *                      LLM and its own issue #1728 shows 41% of 3,950 facts carried invalid_at with
 *                      3 of 4 audited retirements being collateral damage; we start without that.
 * - superseded_by:     id of the row that replaced it
 */
export interface Provenance {
    source_session_id?: string | null;
    source_episode_id?: string | null;
    invalidated_at?: number | null;
    superseded_by?: string | null;
}
/** A row still counts as true unless something explicitly retired it. */
export declare function isLive(row: {
    invalidated_at?: number | null;
}): boolean;
export interface MemoryRow extends Provenance {
    id: string;
    level: Level;
    content: string;
    project?: string | null;
    scope_kind?: ScopeKind | null;
    scope_id?: string | null;
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
export declare function genId(): string;
/** memory.db 路径（全局，跨工作区共享）。 */
export declare function memoryDbPath(home?: string): string;
export interface MemoryDb {
    db: DatabaseSync;
    close(): void;
    create(level: Level, data: Partial<MemoryRow>): MemoryRow;
    read(id: string): MemoryRow | null;
    update(id: string, patch: Partial<MemoryRow>): MemoryRow | null;
    remove(id: string): boolean;
    list(level?: Level, opts?: {
        project?: string[] | null;
        status?: string[] | null;
        days?: number | null;
    }): MemoryRow[];
    all(level?: Level): MemoryRow[];
    /** 全文/关键词检索（BM25 由 recall.ts 负责；这里给原始列表）。 */
    raw(): MemoryRow[];
}
export declare function openDb(path?: string): MemoryDb;
export type { DatabaseSync };
