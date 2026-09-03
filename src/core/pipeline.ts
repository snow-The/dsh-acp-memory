/**
 * acp-memory — core/pipeline.ts（L1 记忆抽取：规则打底 + LLM 按需）
 *
 * 零 DSH 依赖。规则抽取（零成本）自动完成：关键词提取 + 文本分类 + 符号化压缩。
 * LLM 精炼为可选回调（调用方注入），把会话文本提炼成结构化 fact/lesson/user 记忆。
 *
 * 混合策略（用户拍板）：默认规则打底（零 LLM 成本），LLM 按需（可关/阈值控制）。
 */
import { tokenize } from './recall.js';
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
export function extractKeywords(text: string, limit = 8): string[] {
  const tokens = tokenize(text);
  const freq = new Map<string, number>();
  for (const t of tokens) {
    if (t.length < 2) continue;
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([t]) => t);
}

/** 规则分类：识别 fact/lesson/user 偏好的启发式。 */
export function classifyText(text: string): Level {
  const t = String(text ?? '');
  // 教训：明确纠正/坑/教训/失败/注意
  if (/教训|纠正|错误|坑|失败|注意|lesson|mistake|error|bug|失败原因/.test(t)) return 'lesson';
  // 用户偏好：我喜欢/我不喜欢/我希望/请务必
  if (/我喜欢|我不喜欢|我希望|请务必|prefer|我喜欢|偏好/.test(t)) return 'user';
  // 默认原子事实
  return 'fact';
}

/** 符号化压缩：把文本压成紧凑符号行（省 token、利图检索）。 */
export function symbolize(text: string, entities: string[] = []): string {
  const s = String(text ?? '').trim();
  if (!s) return '';
  // 提取可能的实体（大写词 + 中文词）
  const autoEntities = entities.length > 0 ? entities : extractKeywords(s, 5);
  if (autoEntities.length === 0) return s.slice(0, 200);
  return `[${autoEntities.slice(0, 4).join(', ')}] ${s.slice(0, 180)}`;
}

/**
 * 主入口：规则抽取（always）+ LLM 精炼（可选）。
 * 返回待写入的 MemoryRow 数组。
 */
export async function distill(opts: DistillOptions): Promise<Partial<MemoryRow>[]> {
  const { text, project, llm = null, llmMinChars = 200 } = opts;
  const t = String(text ?? '').trim();
  if (!t) return [];

  const out: Partial<MemoryRow>[] = [];

  // 1. 规则抽取：分类 + 关键词
  const level = classifyText(t);
  const keywords = extractKeywords(t);
  out.push({
    level,
    content: t.slice(0, 500),
    project,
    keywords,
  });

  // 2. LLM 按需精炼（超过长度阈值才调用，可关）
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
          corrected: r.corrected ? 1 : 0,
        });
      }
    } catch { /* LLM 失败则仅保留规则抽取结果 */ }
  }

  return out;
}

/** 会话文本 → 符号化摘要（供 ACP graph 的 index-docs 或压缩摘要使用）。 */
export function sessionSummary(events: string[], limit = 300): string {
  const joined = (events ?? []).join('\n').trim();
  if (!joined) return '';
  return joined.slice(0, limit);
}