/**
 * acp-memory — DSH 适配层（薄）：注册 memory_* / acp_recall 工具。
 *
 * 核心逻辑全部在 src/core/（零 DSH 依赖），本文件只做工具面适配。
 * 依赖 ACP：core/acp.ts 读 ~/.dsh/graph/graph.db（data-layer dependency）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { openDb, GLOBAL_PROJECT, PROJECT_SUBCATEGORIES, type Level, type MemoryRow } from './core/db.js';
import { recallSearch, topMemories, projectOverview, hotKeywords } from './core/recall.js';
import { acpGraphAvailable, acpGraphRecall, acpGraphHotEntities } from './core/acp.js';
import { extractKeywords } from './core/pipeline.js';
import { buildFirstInjection, buildHitInjection, buildReinjection, isReinjectPending, markReinjectPending } from './dsh/inject.js';
import { captureTurn, DEFAULT_CAPTURE_CONFIG } from './dsh/capture.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { homedir } from 'node:os';

const textOut = { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }] };

export const name = 'dsh-acp-memory';
export const inject = ['tools'];

const LEVELS_STR = 'soul | user | project | fact | lesson | topic | rules';

function fmtRow(r: MemoryRow): string {
  const head = r.title ?? (r.subcategory ? `[${r.subcategory}]` : '');
  const p = r.project && r.project !== GLOBAL_PROJECT ? ` (@${r.project})` : '';
  const corr = r.corrected ? ' [已纠正]' : '';
  return `- ${head}${p}${corr} ${r.content}`;
}

export async function apply(ctx: any) {
  // 打开全局 memory.db（惰性，单例）
  let mem: ReturnType<typeof openDb> | null = null;
  const getMem = () => (mem ??= openDb());

  // ---------------- memory_remember ----------------
  ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: 'Write a memory entry to the unified seven-layer memory (soul/user/project/fact/lesson/topic/rules) at ~/.dsh/memory/memory.db. Auto-dedupes by content, merges keywords. Returns a read-back confirmation with id and keyword attribution. Rules: fact/lesson one sentence ≤60 chars; user preference quotes preserved verbatim; project requires a project name; topic requires a title.',
    parameters: {
      content: { type: 'string', required: true, description: 'the memory content (one sentence for fact/lesson)' },
      level: { type: 'string', description: `layer: ${LEVELS_STR} (default: fact; user-preference lines auto-classify to user)` },
      project: { type: 'string', description: 'project name this memory belongs to (default 全局)' },
      subcategory: { type: 'string', description: 'for level=project: overview|structure|decisions|quotes|ops|todo' },
      title: { type: 'string', description: 'for level=topic: required title' },
      goal: { type: 'string', description: 'for level=topic: optional goal sentence' },
      keywords: { type: 'string', description: 'comma-separated keywords (auto-extracted if omitted)' },
      importance: { type: 'number', description: '1-3 priority weight (default 1)' },
    },
    output: textOut,
    timeoutMs: 10000,
    async execute(args: any) {
      const content = String(args?.content ?? '').trim();
      if (!content) throw new Error('content required');
      let level = String(args?.level ?? '').trim() as Level;
      if (level && !['soul','user','project','fact','lesson','topic','rules'].includes(level)) {
        throw new Error(`invalid level ${level}; use ${LEVELS_STR}`);
      }
      if (!level) level = /我喜欢|我希望|prefer|偏好/.test(content) ? 'user' : 'fact';
      const project = String(args?.project ?? '').trim() || undefined;
      const subcategory = String(args?.subcategory ?? '').trim() || undefined;
      const title = String(args?.title ?? '').trim() || undefined;
      const goal = String(args?.goal ?? '').trim() || undefined;
      const importance = Number(args?.importance ?? 1) || 1;
      let keywords: string[] = String(args?.keywords ?? '')
        .split(',').map((k: string) => k.trim()).filter(Boolean);
      if (keywords.length === 0) keywords = extractKeywords(content);

      const db = getMem();
      // auto-dedupe: same level+content (exact match) → merge keywords
      const existing = db.list(level).find((r) => r.content.trim() === content);
      let row: MemoryRow;
      if (existing) {
        const merged = Array.from(new Set([...existing.keywords, ...keywords]));
        row = db.update(existing.id, { keywords: merged, project, subcategory, title, goal, importance })!;
      } else {
        row = db.create(level, {
          content,
          project: project ?? (level === 'project' ? GLOBAL_PROJECT : undefined),
          subcategory,
          title,
          goal,
          importance,
          keywords,
        });
      }
      const kw = row.keywords.join(', ');
      return `saved [${row.level}] ${row.id} (project: ${row.project ?? GLOBAL_PROJECT}, keywords: ${kw})\n${row.content}`;
    },
  }));

  // ---------------- memory_search ----------------
  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Search the seven-layer memory with keyword×BM25×recency-decay scoring. Supports level/project/status/days filters. Returns top hits with id, level, content, project, relative age, keywords.',
    parameters: {
      query: { type: 'string', required: true, description: 'search keywords (Chinese bigram + English tokens)' },
      level: { type: 'string', description: `filter by layer: ${LEVELS_STR}` },
      project: { type: 'string', description: 'filter by project name (comma-separated = OR); 全局 always covers' },
      status: { type: 'string', description: 'filter by status: active|archived|stale' },
      days: { type: 'number', description: 'only entries created within N days' },
      limit: { type: 'number', description: 'max results (default 10)' },
    },
    output: textOut,
    timeoutMs: 10000,
    async execute(args: any) {
      const query = String(args?.query ?? '').trim();
      if (!query) throw new Error('query required');
      const db = getMem();
      const hits = recallSearch(db.raw(), {
        query,
        limit: Number(args?.limit ?? 10) || 10,
        levels: args?.level ? [String(args.level) as Level] : null,
        project: args?.project ? String(args.project).split(',').map((s: string) => s.trim()) : null,
        days: args?.days ? Number(args.days) : null,
      });
      if (hits.length === 0) return 'no memory hit';
      return hits.map((h) => `[${h.level}] ${h.id} (score ${h.score.toFixed(3)}, ${ageLabel(h.created_at)})\n  ${fmtRow(h)}`).join('\n');
    },
  }));

  // ---------------- memory_read ----------------
  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: 'Read a single memory entry by id (returned by memory_search/remember).',
    parameters: { id: { type: 'string', required: true, description: 'memory id' } },
    output: textOut,
    timeoutMs: 10000,
    async execute(args: any) {
      const id = String(args?.id ?? '').trim();
      if (!id) throw new Error('id required');
      const db = getMem();
      const row = db.read(id);
      if (!row) return `no memory ${id}`;
      return JSON.stringify({
        id: row.id, level: row.level, content: row.content,
        project: row.project, subcategory: row.subcategory, title: row.title, goal: row.goal,
        corrected: row.corrected, importance: row.importance, status: row.status,
        created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(),
        keywords: row.keywords,
      }, null, 2);
    },
  }));

  // ---------------- memory_update ----------------
  ctx.tools.register(defineTool({
    name: 'memory_update',
    description: 'Update a memory entry (content/project/subcategory/title/goal/importance/status/keywords).',
    parameters: {
      id: { type: 'string', required: true, description: 'memory id' },
      content: { type: 'string', description: 'new content' },
      project: { type: 'string', description: 'new project' },
      subcategory: { type: 'string', description: 'new subcategory' },
      title: { type: 'string', description: 'new title (topic)' },
      goal: { type: 'string', description: 'new goal (topic)' },
      importance: { type: 'number', description: 'new importance' },
      status: { type: 'string', description: 'active|archived|stale' },
      keywords: { type: 'string', description: 'comma-separated new keywords' },
    },
    output: textOut,
    timeoutMs: 10000,
    async execute(args: any) {
      const id = String(args?.id ?? '').trim();
      if (!id) throw new Error('id required');
      const db = getMem();
      const patch: Record<string, unknown> = {};
      if (args.content != null) patch.content = String(args.content);
      if (args.project != null) patch.project = String(args.project);
      if (args.subcategory != null) patch.subcategory = String(args.subcategory);
      if (args.title != null) patch.title = String(args.title);
      if (args.goal != null) patch.goal = String(args.goal);
      if (args.importance != null) patch.importance = Number(args.importance);
      if (args.status != null) patch.status = String(args.status);
      if (args.keywords != null) patch.keywords = String(args.keywords).split(',').map((k: string) => k.trim()).filter(Boolean);
      const row = db.update(id, patch as Partial<MemoryRow>);
      if (!row) return `no memory ${id}`;
      return `updated ${id} [${row.level}]: ${row.content}`;
    },
  }));

  // ---------------- memory_project ----------------
  ctx.tools.register(defineTool({
    name: 'memory_project',
    description: 'Project panorama: all project/topic entries for a project, grouped by subcategory (Scene Navigation). project parameter required — which project do you want to see?',
    parameters: { project: { type: 'string', required: true, description: 'project name (or 全局)' } },
    output: textOut,
    timeoutMs: 10000,
    async execute(args: any) {
      const project = String(args?.project ?? '').trim();
      if (!project) throw new Error('project required');
      const db = getMem();
      const rows = projectOverview(db.raw(), project);
      if (rows.length === 0) return `no memory for project ${project}`;
      const groups = new Map<string, MemoryRow[]>();
      for (const r of rows) {
        const k = r.level === 'topic' ? 'topics' : (r.subcategory ?? 'overview');
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(r);
      }
      const out: string[] = [`## project ${project}`];
      for (const [k, items] of groups) {
        out.push(`### ${k}`);
        for (const r of items) out.push(fmtRow(r));
      }
      return out.join('\n');
    },
  }));

  // ---------------- memory_find_similar ----------------
  ctx.tools.register(defineTool({
    name: 'memory_find_similar',
    description: 'Find similar existing memory entries (dedupe/conflict check) by keyword overlap.',
    parameters: {
      query: { type: 'string', required: true, description: 'text to find similar entries for' },
      limit: { type: 'number', description: 'max results (default 5)' },
    },
    output: textOut,
    timeoutMs: 10000,
    async execute(args: any) {
      const query = String(args?.query ?? '').trim();
      if (!query) throw new Error('query required');
      const db = getMem();
      const hits = recallSearch(db.raw(), { query, limit: Number(args?.limit ?? 5) || 5 });
      if (hits.length === 0) return 'no similar memory';
      return hits.map((h) => fmtRow(h)).join('\n');
    },
  }));

  // ---------------- memory_status ----------------
  ctx.tools.register(defineTool({
    name: 'memory_status',
    description: 'Memory store status: per-layer counts + ACP graph availability.',
    parameters: {},
    output: textOut,
    timeoutMs: 10000,
    async execute() {
      const db = getMem();
      const rows = db.raw();
      const byLevel = new Map<string, number>();
      for (const r of rows) byLevel.set(r.level, (byLevel.get(r.level) ?? 0) + 1);
      const parts = ['## memory store', `db: ${process.env.DSH_HOME ?? homedir()}/.dsh/memory/memory.db`, `total: ${rows.length}`];
      for (const l of ['soul','user','project','fact','lesson','topic','rules']) {
        parts.push(`  ${l}: ${byLevel.get(l) ?? 0}`);
      }
      const hot = hotKeywords(rows, 5);
      if (hot.length) parts.push('hot keywords: ' + hot.join(', '));
      parts.push('acp graph available: ' + acpGraphAvailable());
      if (acpGraphAvailable()) {
        const ents = acpGraphHotEntities(5);
        if (ents.length) parts.push('acp hot entities: ' + ents.map((e) => e.node).join(', '));
      }
      return parts.join('\n');
    },
  }));

  // ---------------- acp_recall ----------------
  ctx.tools.register(defineTool({
    name: 'acp_recall',
    description: 'Cross-checkpoint memory recall: search the ACP graph (~/.dsh/graph/graph.db) plus the seven-layer memory, returning memory the linear surface cannot see (compacted-away content). Use when the user references earlier sessions, past decisions, or shared context.',
    parameters: {
      query: { type: 'string', required: true, description: 'what to recall (topic/entity/decision)' },
      limit: { type: 'number', description: 'max results (default 4)' },
      includeLocal: { type: 'boolean', description: 'also search seven-layer memory (default true)' },
    },
    output: textOut,
    timeoutMs: 15000,
    async execute(args: any) {
      const query = String(args?.query ?? '').trim();
      if (!query) throw new Error('query required');
      const out: string[] = ['## ACP recall: ' + query];
      // 1. ACP graph (cross-checkpoint)
      if (acpGraphAvailable()) {
        const hits = acpGraphRecall(query, Number(args?.limit ?? 4) || 4);
        if (hits.length) {
          out.push('### graph (compacted sessions)');
          for (const h of hits) out.push(`- ${h.node}: ${h.summary.slice(0, 200)}`);
        }
      } else {
        out.push('(acp graph not available — install dsh-session-handoff)');
      }
      // 2. seven-layer local memory
      if (args?.includeLocal !== false) {
        const db = getMem();
        const local = recallSearch(db.raw(), { query, limit: 4 });
        if (local.length) {
          out.push('### local memory');
          for (const h of local) out.push(fmtRow(h));
        }
      }
      return out.join('\n');
    },
  }));


  // ─────────── M3+M4: 记忆捕获 + 注入 hooks ───────────
  const captureConfig = { ...DEFAULT_CAPTURE_CONFIG };
  const firstUserHandled = new Set<string>();

  // session/event：compaction/end → 置重注入待办；turn/end → 自动捕获
  ctx.on('session/event', (session: any, event: any) => {
    try {
      const sid = String(session?.id ?? '');
      if (!sid) return;
      const t = String(event?.type ?? '');
      if (t === 'compaction/end') {
        markReinjectPending(sid);
        ctx.logger?.info('acp-memory: compaction finished, re-injection armed');
      } else if (t === 'turn/end') {
        // 自动捕获（规则打底；LLM 精炼默认关，可配）
        void (async () => {
          try {
            const db = getMem();
            const written = await captureTurn(db, session?.events ?? [], captureConfig, null);
            if (written > 0) ctx.logger?.info('acp-memory: captured ' + written + ' memory entries');
          } catch (err) { console.warn('[acp-memory] capture hook failed:', err instanceof Error ? err.message : String(err)); }
        })();
      }
    } catch { /* 事件监听不阻塞 */ }
  });

  // pre-step：首轮注入 / 每轮命中 / 压缩重注入
  ctx.on('agent/pre-step', async ({ agent, messages, signal }: any, next: any) => {
    try {
      const decision = await next();
      if (decision === undefined || decision.kind !== 'enter' || signal?.aborted) return decision;
      if (!decision.messages || decision.messages.length === 0) return decision;
      if (agent?.session?.header?.origin === 'subagent') return decision;
      const sid = String(agent?.session?.id ?? '');
      if (!sid) return decision;

      // 真实用户消息
      const userMsgs = (decision.messages as any[]).filter((m) => m?.source?.kind === 'user');
      if (userMsgs.length === 0) return decision;
      const lastUser = userMsgs[userMsgs.length - 1];

      // 压缩重注入
      if (isReinjectPending(sid)) {
        const db = getMem();
        const reinj = buildReinjection(db, sid);
        if (reinj !== null) {
          const rewritten = [...decision.messages];
          rewritten.splice(rewritten.indexOf(lastUser), 0, createUserMessage({
            content: [{ type: 'text', text: reinj.text }],
            source: { kind: 'plugin', plugin: 'dsh-acp-memory', form: 'snapshot', sections: [] },
          }));
          return { ...decision, messages: rewritten };
        }
        return decision;
      }

      // 首条用户消息：首轮注入（长期记忆 + 导引 + ACP 热实体）
      if (!firstUserHandled.has(sid)) {
        firstUserHandled.add(sid);
        const priorUser = (agent.session.events ?? []).filter((e: any) => e?.type === 'user/message' && e?.data?.source?.kind === 'user').length;
        if (priorUser === 0) {
          const db = getMem();
          const firstText = String(lastUser?.content?.[0]?.text ?? '');
          const inj = buildFirstInjection(db, sid, firstText);
          if (inj !== null) {
            const rewritten = [...decision.messages];
            rewritten.splice(rewritten.indexOf(lastUser), 0, createUserMessage({
              content: [{ type: 'text', text: inj.text }],
              source: { kind: 'plugin', plugin: 'dsh-acp-memory', form: 'snapshot', sections: [] },
            }));
            return { ...decision, messages: rewritten };
          }
        }
        return decision;
      }

      // 每轮命中（top-2 + ACP recall 融合）
      const db = getMem();
      const queryText = String(lastUser?.content?.[0]?.text ?? '');
      if (queryText) {
        const hit = buildHitInjection(db, sid, queryText, 2);
        if (hit !== null) {
          const rewritten = [...decision.messages];
          rewritten.splice(rewritten.indexOf(lastUser), 0, createUserMessage({
            content: [{ type: 'text', text: hit.text }],
            source: { kind: 'plugin', plugin: 'dsh-acp-memory', form: 'snapshot', sections: [] },
          }));
          return { ...decision, messages: rewritten };
        }
      }
      return decision;
    } catch {
      return undefined;
    }
  });

  // close db on dispose (best-effort)
  return () => { try { mem?.close(); } catch { /* */ } };
}

function ageLabel(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3600_000) + 'h ago';
  if (diff < 30 * 86_400_000) return Math.floor(diff / 86_400_000) + 'd ago';
  return new Date(ms).toISOString().slice(0, 10);
}