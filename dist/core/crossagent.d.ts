export interface CrossAgentHit {
    title: string;
    sources: number;
    agent_kinds: string[];
    mentions: number;
    score: number;
    kind: string | null;
}
export declare function crossAgentDbPath(): string;
/** Is the relation layer present and carrying a consensus digest? */
export declare function crossAgentAvailable(): Promise<boolean>;
/** The strongest cross-context/cross-agent agreements overall. */
export declare function crossAgentHot(limit?: number): Promise<CrossAgentHit[]>;
/** Agreements whose subject matches the current text. */
export declare function crossAgentHits(query: string, limit?: number): Promise<CrossAgentHit[]>;
