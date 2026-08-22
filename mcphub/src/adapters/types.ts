import type { McpServer } from "../types.js";

/**
 * An adapter knows how to read/enable/disable MCP servers in one tool's config.
 * Each implementation is responsible for that tool's file format and key naming.
 */
export interface ToolAdapter {
  /** Absolute path to the config file this adapter manages. */
  readonly configPath: string;
  /** Names of MCP servers currently present in the tool's config. */
  listPresent(): string[];
  /** Read one server's definition, or null if absent or not a stdio (command) server. */
  readServer(name: string): McpServer | null;
  /** Add or overwrite a server entry. Returns the backup path, if any. */
  enable(name: string, def: McpServer): string | null;
  /** Remove a server entry. Returns the backup path, if any. */
  disable(name: string): string | null;
}
