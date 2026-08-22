import TOML from "@iarna/toml";
import { atomicWrite, backupFile, readTextIfExists } from "../fsutil.js";
import type { McpServer } from "../types.js";
import type { ToolAdapter } from "./types.js";
import { asServerMap, commandEntry, toDefinition } from "./entry.js";

/**
 * Codex CLI stores servers as [mcp_servers.<name>] tables in config.toml.
 * We parse the whole document, mutate only that table, and re-serialize.
 * Note: @iarna/toml does not preserve comments, hence the mandatory backup.
 */
export class CodexAdapter implements ToolAdapter {
  constructor(readonly configPath: string) {}

  private read(): Record<string, any> {
    const text = readTextIfExists(this.configPath);
    if (!text || !text.trim()) return {};
    try {
      return TOML.parse(text) as Record<string, any>;
    } catch {
      throw new Error(`${this.configPath} is not valid TOML; fix or remove it first`);
    }
  }

  private write(root: Record<string, any>): string | null {
    const backup = backupFile(this.configPath);
    atomicWrite(this.configPath, TOML.stringify(root as TOML.JsonMap));
    return backup;
  }

  listPresent(): string[] {
    return Object.keys(asServerMap(this.read().mcp_servers));
  }

  readServer(name: string): McpServer | null {
    return toDefinition(asServerMap(this.read().mcp_servers)[name]);
  }

  enable(name: string, def: McpServer): string | null {
    const root = this.read();
    root.mcp_servers ??= {};
    root.mcp_servers[name] = commandEntry(def);
    return this.write(root);
  }

  disable(name: string): string | null {
    const root = this.read();
    if (!root.mcp_servers?.[name]) return null;
    delete root.mcp_servers[name];
    return this.write(root);
  }
}
