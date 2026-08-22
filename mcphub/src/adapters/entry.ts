import type { McpServer } from "../types.js";

/** Build a config entry from a definition, omitting empty args/env.
 *  Shared by every adapter so the on-disk shape stays consistent. */
export function commandEntry(def: McpServer): Record<string, unknown> {
  const entry: Record<string, unknown> = { command: def.command };
  if (def.args?.length) entry.args = def.args;
  if (def.env && Object.keys(def.env).length) entry.env = def.env;
  return entry;
}

/** Read a raw config entry back into a definition, or null if it is not a
 *  stdio (command-based) server — remote/url servers are not modeled yet. */
export function toDefinition(raw: unknown): McpServer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.command !== "string") return null;
  return {
    command: r.command,
    args: Array.isArray(r.args) ? (r.args as string[]) : undefined,
    env: r.env && typeof r.env === "object" ? (r.env as Record<string, string>) : undefined,
  };
}

/** Coerce a possible servers container into a plain object (guards null/array/scalars). */
export function asServerMap(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
