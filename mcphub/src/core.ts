import { getAdapter } from "./adapters/index.js";
import { loadRegistry, saveRegistry } from "./registry.js";
import { ALL_TOOLS, type CellState, type McpServer, type ToolId } from "./types.js";

export type ChangeAction = "add" | "overwrite" | "remove" | "noop";

export interface ChangePlan {
  server: string;
  changes: { tool: ToolId; action: ChangeAction }[];
}

/** Compute the per-tool effect of an enable/disable. Reading each config here
 *  also doubles as preflight: a corrupt target throws before anything is written. */
function planFor(name: string, tools: ToolId[], enabling: boolean): ChangePlan {
  const changes = tools.map((tool) => {
    const present = getAdapter(tool).listPresent().includes(name);
    const action: ChangeAction = enabling
      ? present ? "overwrite" : "add"
      : present ? "remove" : "noop";
    return { tool, action };
  });
  return { server: name, changes };
}

export interface ServerListItem {
  name: string;
  definition: McpServer;
  enabledFor: ToolId[];
}

/** All registered servers with their definition and intended state. */
export function listServers(): ServerListItem[] {
  const reg = loadRegistry();
  return Object.entries(reg.servers).map(([name, entry]) => ({
    name,
    definition: entry.definition,
    enabledFor: entry.enabledFor,
  }));
}

/** Register a server definition without enabling it anywhere. */
export function addServer(name: string, def: McpServer): void {
  const reg = loadRegistry();
  const existing = reg.servers[name];
  reg.servers[name] = { definition: def, enabledFor: existing?.enabledFor ?? [] };
  saveRegistry(reg);
}

/** Remove a server from the registry and from every tool it was enabled in. */
export function removeServer(name: string): void {
  const reg = loadRegistry();
  const entry = reg.servers[name];
  if (!entry) throw new Error(`Unknown server: ${name}`);
  for (const tool of entry.enabledFor) getAdapter(tool).disable(name);
  delete reg.servers[name];
  saveRegistry(reg);
}

export function enable(name: string, tools: ToolId[], dryRun = false): ChangePlan {
  const reg = loadRegistry();
  const entry = reg.servers[name];
  if (!entry) throw new Error(`Unknown server: ${name}. Add it first.`);
  const plan = planFor(name, tools, true);
  if (dryRun) return plan;
  for (const tool of tools) {
    getAdapter(tool).enable(name, entry.definition);
    if (!entry.enabledFor.includes(tool)) entry.enabledFor.push(tool);
  }
  saveRegistry(reg);
  return plan;
}

export function disable(name: string, tools: ToolId[], dryRun = false): ChangePlan {
  const reg = loadRegistry();
  const entry = reg.servers[name];
  if (!entry) throw new Error(`Unknown server: ${name}`);
  const plan = planFor(name, tools, false);
  if (dryRun) return plan;
  for (const tool of tools) getAdapter(tool).disable(name);
  entry.enabledFor = entry.enabledFor.filter((t) => !tools.includes(t));
  saveRegistry(reg);
  return plan;
}

export interface ImportResult {
  imported: string[];
  /** Names present but not importable (e.g. remote/url servers we can't model yet). */
  skipped: string[];
}

/** Read server definitions from a tool's config into the registry, marking them
 *  enabled for that tool. Lets the registry adopt configs set up outside this tool. */
export function importFrom(tool: ToolId, name?: string): ImportResult {
  const reg = loadRegistry();
  const adapter = getAdapter(tool);
  const present = adapter.listPresent();
  if (name && !present.includes(name)) {
    throw new Error(`Server "${name}" not found in ${tool} config`);
  }
  const names = name ? [name] : present;
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const n of names) {
    const def = adapter.readServer(n);
    if (!def) {
      skipped.push(n);
      continue;
    }
    const enabledFor = reg.servers[n] ? [...reg.servers[n].enabledFor] : [];
    if (!enabledFor.includes(tool)) enabledFor.push(tool);
    reg.servers[n] = { definition: def, enabledFor };
    imported.push(n);
  }
  saveRegistry(reg);
  return { imported, skipped };
}

/** Reapply the registry's intended state to every tool config. */
export function sync(): void {
  const reg = loadRegistry();
  for (const [name, entry] of Object.entries(reg.servers)) {
    for (const tool of entry.enabledFor) getAdapter(tool).enable(name, entry.definition);
  }
}

export interface StatusRow {
  name: string;
  state: Record<ToolId, CellState>;
}

/** Actual on-disk state: which tools currently contain each known server.
 *  A tool whose config is unreadable is isolated as "err" and never aborts the rest. */
export function status(): StatusRow[] {
  const reg = loadRegistry();
  const presentByTool = Object.fromEntries(
    ALL_TOOLS.map((t) => {
      try {
        return [t, new Set(getAdapter(t).listPresent())];
      } catch {
        return [t, null]; // unreadable config
      }
    })
  ) as Record<ToolId, Set<string> | null>;

  return Object.keys(reg.servers).map((name) => ({
    name,
    state: Object.fromEntries(
      ALL_TOOLS.map((t) => {
        const set = presentByTool[t];
        return [t, set === null ? "err" : set.has(name) ? "on" : "off"];
      })
    ) as Record<ToolId, CellState>,
  }));
}
