import type { MemoryDb, MemoryRow } from '../core/db.js';
export interface SessionSeen {
    injected: string[];
    searched: string[];
    reinjectPending: boolean;
}
export declare function sessionsDir(home?: string): string;
export declare function sessionsFile(sid: string): string;
export declare function readSeen(sid: string): SessionSeen;
export declare function markInjected(sid: string, ids: string[]): void;
export declare function markSearched(sid: string, ids: string[]): void;
export declare function markReinjectPending(sid: string): void;
export declare function clearReinjectPending(sid: string): void;
export declare function isReinjectPending(sid: string): boolean;
/**
 * 自动注入的尺度。
 * - scoped（默认）：只注入全局身份 + 一行索引。跨对话内容一律不推，改为按需查询。
 * - full：2026-09-13 之前的行为（项目/话题清单 + 热实体 + 跨会话共识 + 每轮命中）。
 * - off：完全不自动注入。
 */
export type InjectMode = 'scoped' | 'full' | 'off';
export declare function injectMode(env?: Record<string, string | undefined>): InjectMode;
/**
 * 记忆索引：只说"库里有哪几个域、各多少条"，不说内容。
 * 这是全域唯一该常驻的东西——工具与环境的大概索引；内容靠 memory_search / memory_project 取。
 */
export declare function memoryIndex(rows: MemoryRow[]): string;
export interface Injection {
    text: string;
    injectedIds: string[];
}
export interface InjectOptions {
    mode?: InjectMode;
}
/** 首轮注入：scoped = soul/user/rules + 索引；full = 原来的导引 + 热实体 + 共识 + 命中 top-2。 */
export declare function buildFirstInjection(db: MemoryDb, sid: string, queryText: string, hitTopK?: number, opts?: InjectOptions): Promise<Injection | null>;
/**
 * 每轮命中注入。scoped 模式下返回 null：
 * 没有工作区信号时，"每轮从全局库捞 2 条"就是串味的来源，宁可一条都不推。
 */
export declare function buildHitInjection(db: MemoryDb, sid: string, queryText: string, hitTopK?: number, opts?: InjectOptions): Promise<Injection | null>;
/** 压缩重注入：scoped = 全局身份 + 索引；full = 原来的 top + 话题清单。 */
export declare function buildReinjection(db: MemoryDb, sid: string, opts?: InjectOptions): Injection | null;
