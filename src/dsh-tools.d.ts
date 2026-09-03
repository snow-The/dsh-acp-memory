// Minimal local type shim for @deepseek-ai/dsh-tools.
// The runtime module is injected by the DSH host (esbuild keeps the import external).
declare module '@deepseek-ai/dsh-tools' {
  export interface ToolDef {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: { schema: { type: string }; render?: (args: unknown, value: unknown) => unknown[] };
    timeoutMs?: number;
    execute(args: unknown): Promise<unknown>;
  }
  export function defineTool(def: ToolDef): ToolDef;
}
// Minimal local type shim for @deepseek-ai/dsh-llm (createUserMessage).
declare module '@deepseek-ai/dsh-llm' {
  export interface MessageSourcePlugin {
    kind: 'plugin';
    plugin: string;
    form?: string;
    memory?: unknown;
    sections?: unknown[];
    summary?: string;
  }
  export function createUserMessage(opts: {
    content: Array<{ type: string; text: string }>;
    source?: MessageSourcePlugin | { kind: string; [k: string]: unknown };
  }): unknown;
}
