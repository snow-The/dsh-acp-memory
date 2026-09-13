import type { Level, MemoryRow } from './db.js';
export interface LlmDistillResult {
    level: Level;
    content: string;
    project?: string;
    keywords: string[];
    importance?: number;
    corrected?: boolean;
}
export type LlmDistiller = (text: string) => Promise<LlmDistillResult[]>;
export interface DistillOptions {
    text: string;
    project?: string;
    llm?: LlmDistiller | null;
    /** LLM 精炼的文本长度阈值（超过才值得 LLM 精炼）。 */
    llmMinChars?: number;
}
/** 规则提取关键词：tokenize + 词频 topN。 */
export declare function extractKeywords(text: string, limit?: number): string[];
/** 规则分类：识别 fact/lesson/user 偏好的启发式。 */
export declare function classifyText(text: string): Level;
/** 符号化压缩：把文本压成紧凑符号行（省 token、利图检索）。 */
export declare function symbolize(text: string, entities?: string[]): string;
/**
 * 主入口：规则抽取（always）+ LLM 精炼（可选）。
 * 返回待写入的 MemoryRow 数组。
 */
export declare function distill(opts: DistillOptions): Promise<Partial<MemoryRow>[]>;
/** 会话文本 → 符号化摘要（供 ACP graph 的 index-docs 或压缩摘要使用）。 */
export declare function sessionSummary(events: string[], limit?: number): string;
