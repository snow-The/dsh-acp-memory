/** FTS5 phrase builder: quotes every token so user text (paths like C:\\x, "*", ":", quotes)
 * can never be parsed as column filters or operators. Falls back to a harmless empty phrase. */
export declare function ftsPhrase(q: unknown): string;
export declare function acpGraphPath(): string;
export declare function acpGraphAvailable(): boolean;
export interface AcpRecallHit {
    node: string;
    summary: string;
    score: number;
}
/** 查询 ACP 图，返回跨会话 checkpoint 命中（FTS5 实体 + 摘要）。 */
export declare function acpGraphRecall(query: string, limit?: number): AcpRecallHit[];
/** 热实体（ACP 图的高频节点，供首轮注入引导）。 */
export declare function acpGraphHotEntities(limit?: number): {
    node: string;
    count: number;
}[];
