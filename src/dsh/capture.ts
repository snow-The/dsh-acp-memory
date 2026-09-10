/**
 * acp-memory — dsh/capture.ts（M3 自动记忆捕获）
 *
 * 监听 session/event：turn/end 时扫描本轮文本，规则抽取（always）+ LLM 精炼（按需阈值），
 * 写入 memory.db。默认规则打底（零 LLM 成本），LLM 精炼通过阈值控制（可关）。
 */
import type { MemoryDb } from '../core/db.js';
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
export async function captureTurn(
  db: MemoryDb,
  events: readonly unknown[],
  config: CaptureConfig,
  llm?: LlmDistiller | null,
): Promise<number> {
  const text = scanTurnText(events);
  if (!text.trim()) return 0;
  try {
    const entries = await distill({
      text,
      llm: config.llmEnabled ? (llm ?? null) : null,
      llmMinChars: config.llmMinChars,
    });
    let written = 0;
    for (const e of entries.slice(0, config.maxDistillPerTurn)) {
      // 自动去重：同 level+content 已存在则跳过
      const level = e.level ?? 'fact';
      const exists = db.list(level).some((r) => r.content.trim() === (e.content ?? '').trim());
      if (exists) continue;
      db.create(level, e as never);
      written++;
    }
    return written;
  } catch (err) {
    // Never silent again: swallowing this made auto-capture write nothing for a week
    // while every health check looked green.
    console.warn('[acp-memory] capture failed:', err instanceof Error ? err.message : String(err));
    return 0;
  }
}
