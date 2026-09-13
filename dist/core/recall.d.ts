/**
 * acp-memory — core/recall.ts（记忆检索：关键词 × BM25 × 艾宾浩斯衰减）
 *
 * 零 DSH 依赖。检索基于条目 keywords（LLM 提取或自动 bigram）而非全文——
 * 全文匹配噪音大（meow 设计）。打分 = 交集分 × idf × 覆盖率 × 衰减 × importance。
 */
import { type Level, type MemoryRow, type Scope } from './db.js';
/** 分词：英文词 + 中文 bigram（w8 风格）。 */
export declare function tokenize(text: string): string[];
/** 艾宾浩斯衰减：1/(1+ln(1+ageDays))，近期记忆权重大。 */
export declare function ebbinghausDecay(createdAt: number, now?: number): number;
export interface RecallHit extends MemoryRow {
    score: number;
}
export interface RecallOpts {
    query: string;
    /**
     * REQUIRED. A Scope limits hits to that scope plus global identity rows. The literal 'any'
     * is the explicit opt-in used by user-driven search (memory_search) and spans everything,
     * including legacy rows of unknown provenance. Omitting it returns NO hits on purpose.
     */
    scope: Scope | 'any';
    limit?: number;
    levels?: Level[] | null;
    project?: string[] | null;
    status?: string[] | null;
    days?: number | null;
    minScore?: number;
    now?: number;
    /** Include rows something explicitly retired. Off by default: a retracted claim must not resurface. */
    includeInvalidated?: boolean;
}
/**
 * 关键词命中检索。query 分词 → 与每条记忆的 keywords（+ title/content 分词）求交集，
 * 打分 = 交集分 × idf × 覆盖率 × 艾宾浩斯衰减 × importance。
 */
export declare function recallSearch(rows: MemoryRow[], opts: RecallOpts): RecallHit[];
/** A statement is something a person could assert in one breath; longer than this, it is a dump. */
export declare const MAX_STATEMENT_CHARS = 240;
/**
 * 是不是"自动捕获的一整轮对话"（而不是一条陈述）。
 * 真实事故：自动分类器是 /我喜欢|我希望|prefer|偏好/ 的子串测试，而"我**不喜欢**你"里含有"我喜欢"，
 * 于是另一个对话的整段剧本被存成 [user] 并当成"用户偏好"注入到每一个对话里。识别特征很明确：
 * 以 user:/assistant: 开头，或正文里出现换行后的 user:/assistant:。
 */
export declare function looksLikeDialogue(content: string): boolean;
/**
 * 顶层记忆（首轮注入）：soul 全量 + user（仅人工陈述）+ rules importance≥2。
 * 只有 global 域参与：身份层是唯一天然跨对话的东西，而"来源不明"（legacy）不等于"全局"，
 * 它就是来历不明的历史——曾经把 309 行这种行灌进每一段对话的正是这个混淆。
 */
export declare function topMemories(rows: MemoryRow[]): MemoryRow[];
/** 项目全景：按 project 名取 project/topic 条目（Scene Navigation）。 */
export declare function projectOverview(rows: MemoryRow[], project: string): MemoryRow[];
/** 热实体（从关键词频率聚合，供首轮注入引导）。 */
export declare function hotKeywords(rows: MemoryRow[], limit?: number): string[];
