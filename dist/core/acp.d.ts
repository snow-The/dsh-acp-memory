/**
 * acp-memory — core/acp.ts（ACP graph 数据层）
 *
 * dsh-session-handoff 的 ACP 图 (~/.dsh/graph/graph.db) 是跨会话长期记忆的权威图。
 * 本模块通过【规范化只读契约】复用它，而不是裸 SQLite + 硬编码表名。
 *
 * 为什么改成契约（历史教训）
 * --------------------------
 * 原实现直接 `new DatabaseSync(acpGraphPath())` 然后拼表名，并且"失败即返回 []"。
 * 后果是三种完全不同的状况在调用方看来一模一样：
 *   - 本来就没数据（正常）
 *   - 库不存在 / 插件没装（正常降级）
 *   - schema 变了 / 库被锁 / 库比消费方新（故障——但静默返回 []）
 * 本文件原先的注释就记着这类静默故障曾造成【一周哑火】。
 *
 * 现在：所有读取经 core/acp-graph-contract.ts（由 dsh-acp-graph-contract 同步而来，
 * 顶部带源哈希，漂移会被 --check 抓到）。它返回具名的 Result，因此"没有数据"和
 * "读取失败"不再混淆；失败原因通过 acpGraphProblem() 暴露给诊断输出。
 *
 * 边界：只读。图的结构与数据只能由生产者(handoff)变更——见契约文件头。
 */
import { acpGraphOr, ftsPhrase as contractFtsPhrase, type AcpGraphStatus, type AcpRecallHit } from './acp-graph-contract.js';
export type { AcpGraphStatus, AcpRecallHit };
/** FTS5 phrase builder（规范化实现；原先 4 个插件各自复制了一份）。 */
export declare const ftsPhrase: typeof contractFtsPhrase;
/** 诊断用：契约状态 + 最近一次失败原因。 */
export declare function acpGraphDiagnostics(): {
    status: AcpGraphStatus;
    lastProblem: {
        detail: string;
        status: AcpGraphStatus;
    } | null;
};
/**
 * 一行人类可读的状态，用于工具输出。
 * 刻意区分"没装"与"装了但读不了"——旧文案在图不可用时一律说
 * "(acp graph not available — install dsh-session-handoff)"，
 * 即使插件已装、只是 schema 不匹配，也会把人引向错误的方向。
 */
export declare function acpGraphStatusLine(): string;
/**
 * 图是否【可读】。
 *
 * 语义变更有意为之：旧实现判的是"checkpoints 表非空"，于是"库健康但没有 checkpoint"
 * 会被报成"不可用"，调用方进而打印"请安装 handoff"——误导。现在判的是契约是否可读，
 * 与数据量无关。
 */
export declare function acpGraphAvailable(): boolean;
/** 查询 ACP 图，返回跨会话 checkpoint 命中（FTS5 实体 + 摘要）。失败返回 [] 并记录原因。 */
export declare function acpGraphRecall(query: string, limit?: number): AcpRecallHit[];
/** 热实体（ACP 图的高频节点，供首轮注入引导）。失败返回 [] 并记录原因。 */
export declare function acpGraphHotEntities(limit?: number): {
    node: string;
    count: number;
}[];
/** 便捷：在契约保护下跑任意只读查询（供将来扩展；失败回退 fallback）。 */
export declare function withAcpGraphRead<T>(fallback: T, fn: Parameters<typeof acpGraphOr<T>>[1]): T;
