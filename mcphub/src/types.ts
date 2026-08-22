/** Supported client tools that consume MCP configuration. */
export type ToolId = "claude-code" | "cursor" | "vscode" | "codex";

export const ALL_TOOLS: ToolId[] = ["claude-code", "cursor", "vscode", "codex"];

/** A single MCP server definition, format-agnostic across all tools. */
export interface McpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Registry entry: the definition plus the tools it is currently enabled for. */
export interface RegistryEntry {
  definition: McpServer;
  enabledFor: ToolId[];
}

/** The registry is the single source of truth owned by this tool. */
export interface Registry {
  servers: Record<string, RegistryEntry>;
}

/** Per-cell state in the status matrix. "err" = that tool's config is unreadable. */
export type CellState = "on" | "off" | "err";
