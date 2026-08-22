import { toolConfigPaths } from "../paths.js";
import type { McpServer, ToolId } from "../types.js";
import { JsonAdapter } from "./json-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { commandEntry } from "./entry.js";
import type { ToolAdapter } from "./types.js";

/** VS Code expects a transport `type` field alongside the command. */
function vscodeEntry(def: McpServer): Record<string, unknown> {
  return { type: "stdio", ...commandEntry(def) };
}

export function getAdapter(tool: ToolId): ToolAdapter {
  const configPath = toolConfigPaths[tool];
  switch (tool) {
    case "claude-code":
      return new JsonAdapter(configPath, "mcpServers", commandEntry);
    case "cursor":
      return new JsonAdapter(configPath, "mcpServers", commandEntry);
    case "vscode":
      return new JsonAdapter(configPath, "servers", vscodeEntry);
    case "codex":
      return new CodexAdapter(configPath);
  }
}

export type { ToolAdapter };
