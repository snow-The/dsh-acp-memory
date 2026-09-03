/**
 * acp-memory — core/recall.ts（记忆检索：关键词 × BM25 × 艾宾浩斯衰减）
 *
 * 零 DSH 依赖。检索基于条目 keywords（LLM 提取或自动 bigram）而非全文——
 * 全文匹配噪音大（meow 设计）。打分 = 交集分 × idf × 覆盖率 × 衰减 × importance。
 */
import type { Level, MemoryRow } from './db.js';

/** 分词：英文词 + 中文 bigram（w8 风格）。 */
export function tokenize(text: string): string[] {
  const s = String(text ?? '').toLowerCase();
  const words = s.match(/[a-z0-9_]+/g) ?? [];
  const cjk = s.replace(/[a-z0-9_]/g, ' ').replace(/\s+/g, '');
  const bigrams: string[] = [];
  for (let i = 0; i < cjk.length - 1; i++) bigrams.push(cjk.slice(i, i + 2));
  return [...words, ...bigrams];
}

/** 艾宾浩斯衰减：1/(1+ln(1+ageDays))，近期记忆权重大。 */
export function ebbinghausDecay(createdAt: number, now = Date.now()): number {
  const ageDays = Math.max(0, (now - createdAt) / 86_400_000);
  return 1 / (1 + Math.log(1 + ageDays));
}

/** 关键词 idf：出现越少越重要。 */
function idf(keyword: string, allKeywordSets: string[][]): number {
  const df = allKeywordSets.filter((ks) => ks.includes(keyword)).length;
  const n = Math.max(1, allKeywordSets.length);
  return Math.log(1 + n / (1 + df));
}

export interface RecallHit extends MemoryRow {
  score: number;
}

export interface RecallOpts {
  query: string;
  limit?: number;
  levels?: Level[] | null;
  project?: string[] | null;
  status?: string[] | null;
  days?: number | null;
  minScore?: number;
  now?: number;
}

/**
 * 关键词命中检索。query 分词 → 与每条记忆的 keywords（+ title/content 分词）求交集，
 * 打分 = 交集分 × idf × 覆盖率 × 艾宾浩斯衰减 × importance。
 */
export function recallSearch(rows: MemoryRow[], opts: RecallOpts): RecallHit[] {
  const { query, limit = 10, levels = null, project = null, status = null, days = null, minScore = 0, now = Date.now() } = opts;
  if (!query) return [];

  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return [];

  // 候选集（level/project 过滤）
  let cand = rows;
  if (levels && levels.length > 0) cand = cand.filter((r) => levels.includes(r.level));
  if (project && project.length > 0) {
    cand = cand.filter((r) => {
      const p = r.project ?? '全局';
      return project.some((x) => x === p || x === '全局' || p === '全局');
    });
  }
  if (status && status.length > 0) {
    cand = cand.filter((r) => status.includes(r.status));
  }
  if (days && days > 0) {
    cand = cand.filter((r) => now - r.created_at <= days * 86_400_000);
  }

  const allKeywordSets = cand.map((r) => r.keywords);

  const scored: RecallHit[] = [];
  for (const row of cand) {
    const rowTokens = new Set([...row.keywords, ...tokenize(row.content + ' ' + (row.title ?? '') + ' ' + (row.goal ?? ''))]);
    const inter = [...qTokens].filter((t) => rowTokens.has(t));
    if (inter.length === 0) continue;

    // 交集分 × idf
    let raw = 0;
    for (const t of inter) raw += idf(t, allKeywordSets);
    // 覆盖率（命中关键词 / 查询关键词）
    const coverage = inter.length / qTokens.size;
    // 艾宾浩斯衰减 × importance
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

/** 顶层记忆（首轮注入）：soul/user 全量 + rules importance≥2。 */
export function topMemories(rows: MemoryRow[]): MemoryRow[] {
  return rows.filter((r) =>
    r.level === 'soul' || r.level === 'user' ||
    (r.level === 'rules' && (r.importance ?? 1) >= 2),
  );
}

/** 项目全景：按 project 名取 project/topic 条目（Scene Navigation）。 */
export function projectOverview(rows: MemoryRow[], project: string): MemoryRow[] {
  const p = project === '全局' ? null : project;
  return rows.filter((r) =>
    (r.level === 'project' || r.level === 'topic') &&
    (p === null ? true : (r.project ?? '全局') === p || (r.project ?? '全局') === '全局'),
  );
}

/** 热实体（从关键词频率聚合，供首轮注入引导）。 */
export function hotKeywords(rows: MemoryRow[], limit = 5): string[] {
  const freq = new Map<string, number>();
  for (const r of rows) {
    for (const k of r.keywords) freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k);
}