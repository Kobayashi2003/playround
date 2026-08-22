import os from "node:os";
import path from "node:path";
import type { ToolId } from "./types.js";

const home = os.homedir();

/** This tool's own data directory (holds the registry, the source of truth). */
export const dataDir = path.join(home, ".mcphub");
export const registryPath = path.join(dataDir, "registry.json");

/**
 * Default global config file for each tool on Windows.
 * Project-scoped configs are intentionally out of scope for the CLI's first version.
 */
export const toolConfigPaths: Record<ToolId, string> = {
  "claude-code": path.join(home, ".claude.json"),
  cursor: path.join(home, ".cursor", "mcp.json"),
  vscode: path.join(
    home,
    "AppData",
    "Roaming",
    "Code",
    "User",
    "mcp.json"
  ),
  codex: path.join(home, ".codex", "config.toml"),
};
