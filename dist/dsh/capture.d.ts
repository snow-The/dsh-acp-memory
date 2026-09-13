/**
 * acp-memory — dsh/capture.ts（M3 自动记忆捕获）
 *
 * 监听 session/event：turn/end 时扫描本轮文本，规则抽取（always）+ LLM 精炼（按需阈值），
 * 写入 memory.db。默认规则打底（零 LLM 成本），LLM 精炼通过阈值控制（可关）。
 */
import type { MemoryDb, Scope } from '../core/db.js';
import { type LlmDistiller } from '../core/pipeline.js';
export interface CaptureConfig {
    /** LLM 精炼开关（默认关——规则打底零成本）。 */
    llmEnabled: boolean;
    /** 触发 LLM 精炼的文本长度阈值（超过才值得精炼）。 */
    llmMinChars: number;
    /** 每 turn 最大精炼 token 预算（防止 LLM 抽取失控）。 */
    maxDistillPerTurn: number;
}
export declare const DEFAULT_CAPTURE_CONFIG: CaptureConfig;
/**
 * Resolve a session's event list.
 *
 * The harness Session has NO `events` property: it exposes the log through methods
 * (`ownEvents()`, `snapshotEvents()`) and a private `log` array. Reading
 * `session.events` yields undefined, and `?? []` silently turned that into
 * "nothing to capture" on every single turn - no exception, no log line, zero rows
 * for days. Prefer the public accessors, fall back to the raw log.
 */
export declare function sessionEvents(session: unknown): readonly unknown[];
/**
 * Extract this turn's text: from the last turn/start to the end of the log.
 *
 * TOTAL BY CONTRACT. The events come from the harness, but they are still untrusted
 * shapes: a fuzz run with null entries, non-array message content and a throwing property
 * getter made this throw on 139 of 400 cases. Production wraps the call, so the harness
 * survived - but the turn's memory was silently lost, which is the failure mode this whole
 * path exists to prevent. Every element is now inspected defensively and skipped if it is
 * not what it claims to be.
 */
export declare function scanTurnText(events: readonly unknown[]): string;
/**
 * turn/end 捕获入口：扫描本轮文本 → 规则抽取 → 可选 LLM 精炼 → 写入 memory.db。
 * 返回写入条数（供日志）。
 */
/**
 * The promotion rule, as a pure function: what may leave the episode layer?
 * scanTurnText() labels the speaker, so raw material arrives as a transcript ("user: ...").
 * De-label ONE speaker, then require a statement: a back-and-forth ("\nassistant: ...") stays
 * raw, an oversized blob stays raw, and an empty result promotes nothing.
 * Also exported for tests -- this rule is the difference between "memory" and "the last thing
 * that was said", and it used to have no gate at all.
 */
export declare function promotableStatement(raw: string): string | null;
export declare function captureTurn(db: MemoryDb, events: readonly unknown[], config: CaptureConfig, llm?: LlmDistiller | null, 
/**
 * Which domain this turn belongs to. Auto-capture MUST stamp one: an unstamped turn is
 * indistinguishable from "true everywhere", which is how raw dialogue from one conversation
 * ended up injected into every other one. No scope -> rows land in legacy (never auto-recalled,
 * findable only by an explicit query).
 */
scope?: Scope): Promise<number>;
