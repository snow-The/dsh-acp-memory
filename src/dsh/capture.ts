/**
 * acp-memory — dsh/capture.ts（M3 自动记忆捕获）
 *
 * 监听 session/event：turn/end 时扫描本轮文本，规则抽取（always）+ LLM 精炼（按需阈值），
 * 写入 memory.db。默认规则打底（零 LLM 成本），LLM 精炼通过阈值控制（可关）。
 */
import type { MemoryDb, Scope } from '../core/db.js';
import { looksLikeDialogue, MAX_STATEMENT_CHARS } from '../core/recall.js';
import { distill, extractKeywords, type LlmDistiller } from '../core/pipeline.js';

export interface CaptureConfig {
  /** LLM 精炼开关（默认关——规则打底零成本）。 */
  llmEnabled: boolean;
  /** 触发 LLM 精炼的文本长度阈值（超过才值得精炼）。 */
  llmMinChars: number;
  /** 每 turn 最大精炼 token 预算（防止 LLM 抽取失控）。 */
  maxDistillPerTurn: number;
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  llmEnabled: false,
  llmMinChars: 200,
  maxDistillPerTurn: 8,
};

/**
 * Resolve a session's event list.
 *
 * The harness Session has NO `events` property: it exposes the log through methods
 * (`ownEvents()`, `snapshotEvents()`) and a private `log` array. Reading
 * `session.events` yields undefined, and `?? []` silently turned that into
 * "nothing to capture" on every single turn - no exception, no log line, zero rows
 * for days. Prefer the public accessors, fall back to the raw log.
 */
export function sessionEvents(session: unknown): readonly unknown[] {
  const s = session as { ownEvents?: () => unknown; snapshotEvents?: () => unknown; log?: unknown; events?: unknown } | null | undefined;
  if (s === null || s === undefined) return [];
  for (const read of [() => s.ownEvents?.(), () => s.snapshotEvents?.()]) {
    try {
      const events = read();
      if (Array.isArray(events)) return events;
    } catch { /* try the next accessor */ }
  }
  if (Array.isArray(s.log)) return s.log;
  if (Array.isArray(s.events)) return s.events;
  return [];
}

/** 提取本 turn 的文本（从最近 turn/start 到末尾的 user/assistant 消息）。 */
/** Text blocks of a message payload, tolerating anything that is not the expected shape. */
function textBlocks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];                 // a non-array here used to throw "…filter is not a function"
  const out: string[] = [];
  for (const block of value) {
    if (block === null || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
  }
  return out;
}

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
export function scanTurnText(events: readonly unknown[]): string {
  if (!Array.isArray(events)) return '';
  let startIdx = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    try {
      const e = events[i] as { type?: unknown } | null | undefined;
      if (e !== null && e !== undefined && e.type === 'turn/start') { startIdx = i; break; }
    } catch { /* a hostile getter is not a turn marker */ }
  }
  const texts: string[] = [];
  for (let i = startIdx; i < events.length; i++) {
    try {
      const e = events[i] as { type?: unknown; data?: unknown } | null | undefined;
      if (e === null || e === undefined || typeof e !== 'object') continue;
      const data = (e as { data?: unknown }).data as {
        source?: { kind?: unknown; plugin?: unknown };
        content?: unknown;
        message?: { content?: unknown } | null;
      } | null | undefined;
      if (e.type === 'user/message') {
        const src = data?.source;
        if (src?.kind === 'plugin') continue; // 跳过插件注入（不污染记忆）
        const t = textBlocks(data?.content).join(' ');
        if (t) texts.push('user: ' + t);
      } else if (e.type === 'assistant/message') {
        const t = textBlocks(data?.message?.content).join(' ');
        if (t) texts.push('assistant: ' + t);
      }
    } catch { /* one unreadable event must not cost the whole turn */ }
  }
  return texts.join('\n');
}

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
export function promotableStatement(raw: string): string | null {
  const content = String(raw ?? '').replace(/^\s*(user|assistant|system)\s*:\s*/i, '').trim();
  if (!content) return null;
  if (looksLikeDialogue(content)) return null;
  if (content.length > MAX_STATEMENT_CHARS) return null;
  return content;
}

export async function captureTurn(
  db: MemoryDb,
  events: readonly unknown[],
  config: CaptureConfig,
  llm?: LlmDistiller | null,
  /**
   * Which domain this turn belongs to. Auto-capture MUST stamp one: an unstamped turn is
   * indistinguishable from "true everywhere", which is how raw dialogue from one conversation
   * ended up injected into every other one. No scope -> rows land in legacy (never auto-recalled,
   * findable only by an explicit query).
   */
  scope?: Scope,
): Promise<number> {
  const text = scanTurnText(events);
  if (!text.trim()) return 0;
  const sc = scope ?? { kind: 'legacy' as const, id: 'legacy' };
  try {
    // 1. Raw layer FIRST. The episode is the record of what was said; it is never promoted to a
    //    stronger claim and nothing injects it. Peers separate these too: Zep ingests episodes and
    //    derives facts from them, A-MEM notes never become a fact tier, mem0 extracts at write time.
    //    Auto-capture used to write the turn text straight into fact/lesson, which is how 500-char
    //    dialogue dumps -- including the user complaining about memory bleed -- became searchable
    //    "lessons" that were then injected back into other conversations.
    const episodeExists = db.list('episode').find((r) => r.content === text);
    const episode = episodeExists ?? db.create('episode', {
      content: text, keywords: extractKeywords(text), scope_kind: sc.kind, scope_id: sc.id,
      source_session_id: sc.kind === 'session' ? sc.id : null,
    } as never);

    // 2. Promotion is gated: only a STATEMENT may become a fact/lesson. Identity layers
    //    (soul/user/rules) are never written here at all -- a regex guess about a whole turn is not
    //    evidence about the user, and those layers reach every conversation on the machine.
    // Auto-capture RECORDS; it does not assert. Without a real extractor the rule-based path
    // returns the turn text itself -- a transcript -- and promoting that is exactly what put 316
    // raw dialogue dumps in the lesson layer. Semantic layers are written by an extractor or
    // explicitly, through memory_remember.
    if (llm == null) return 0;
    const entries = await distill({ text, llm, llmMinChars: config.llmMinChars });
    let written = 0;
    for (const e of entries.slice(0, config.maxDistillPerTurn)) {
      const content = promotableStatement(String(e.content ?? ''));
      if (content === null) continue;
      const level = e.level === 'lesson' ? 'lesson' : 'fact';
      // 自动去重：同 level+content 已存在则跳过
      const exists = db.list(level).some((r) => r.content.trim() === content);
      if (exists) continue;
      // Provenance travels with the promotion: which conversation, and the exact episode it came
      // from. Without this a bad memory cannot be traced back to what produced it.
      db.create(level, {
        ...(e as object), content, scope_kind: sc.kind, scope_id: sc.id,
        source_session_id: sc.kind === 'session' ? sc.id : null,
        source_episode_id: episode?.id ?? null,
      } as never);
      written++;
    }
    // The return value counts SEMANTIC entries only: callers log "captured N memory entries", and
    // an episode is not a memory entry -- it is the raw material one could be derived from.
    return written;
  } catch (err) {
    // Never silent again: swallowing this made auto-capture write nothing for a week
    // while every health check looked green.
    console.warn('[acp-memory] capture failed:', err instanceof Error ? err.message : String(err));
    return 0;
  }
}
