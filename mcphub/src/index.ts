#!/usr/bin/env node
import { Command } from "commander";
import {
  addServer,
  removeServer,
  enable,
  disable,
  sync,
  status,
  importFrom,
  type ChangePlan,
} from "./core.js";
import { loadRegistry } from "./registry.js";
import { ALL_TOOLS, type McpServer, type ToolId } from "./types.js";

const program = new Command();
program
  .name("mcpm")
  .description("Toggle MCP servers across VS Code, Cursor, Claude Code and Codex")
  .version("0.1.0");

/** Parse a --for value ("all" or comma list) into validated tool ids. */
function parseTools(value: string | undefined): ToolId[] {
  if (!value || value === "all") return [...ALL_TOOLS];
  const tools = value.split(",").map((s) => s.trim());
  for (const t of tools) {
    if (!ALL_TOOLS.includes(t as ToolId)) throw new Error(`Unknown tool: ${t}`);
  }
  return tools as ToolId[];
}

function parseEnv(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx < 0) throw new Error(`Invalid --env "${pair}", expected KEY=VALUE`);
    env[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return env;
}

const collect = (val: string, prev: string[]) => [...prev, val];

/** Print an enable/disable plan; used for both --dry-run and applied changes. */
function printPlan(plan: ChangePlan, dryRun: boolean): void {
  console.log(dryRun ? `Dry run for "${plan.server}":` : `"${plan.server}":`);
  for (const { tool, action } of plan.changes) {
    console.log(`  ${tool.padEnd(12)} ${action}`);
  }
}

program
  .command("add <name>")
  .description("Register an MCP server definition")
  .requiredOption("-c, --command <command>", "executable to launch the server")
  .option("-a, --arg <arg>", "argument (repeatable)", collect, [])
  .option("-e, --env <KEY=VALUE>", "environment variable (repeatable)", collect, [])
  .action((name: string, opts: { command: string; arg: string[]; env: string[] }) => {
    const def: McpServer = {
      command: opts.command,
      args: opts.arg,
      env: parseEnv(opts.env),
    };
    addServer(name, def);
    console.log(`Added "${name}". Enable it with: mcpm enable ${name}`);
  });

program
  .command("rm <name>")
  .description("Remove a server from the registry and all tools")
  .action((name: string) => {
    removeServer(name);
    console.log(`Removed "${name}".`);
  });

program
  .command("enable <name>")
  .description("Enable a server in the given tools (default: all)")
  .option("-f, --for <tools>", 'comma list or "all"')
  .option("-n, --dry-run", "preview changes without writing")
  .action((name: string, opts: { for?: string; dryRun?: boolean }) => {
    const tools = parseTools(opts.for);
    const plan = enable(name, tools, opts.dryRun);
    printPlan(plan, !!opts.dryRun);
    if (!opts.dryRun) console.log("Restart the affected tools to take effect.");
  });

program
  .command("disable <name>")
  .description("Disable a server in the given tools (default: all)")
  .option("-f, --for <tools>", 'comma list or "all"')
  .option("-n, --dry-run", "preview changes without writing")
  .action((name: string, opts: { for?: string; dryRun?: boolean }) => {
    const tools = parseTools(opts.for);
    const plan = disable(name, tools, opts.dryRun);
    printPlan(plan, !!opts.dryRun);
    if (!opts.dryRun) console.log("Restart the affected tools to take effect.");
  });

program
  .command("import <tool> [name]")
  .description("Import server definitions from a tool's config into the registry")
  .action((tool: string, name: string | undefined) => {
    const tools = parseTools(tool);
    if (tools.length !== 1) throw new Error("import takes exactly one tool");
    const { imported, skipped } = importFrom(tools[0], name);
    console.log(`Imported ${imported.length}: ${imported.join(", ") || "(none)"}`);
    if (skipped.length) {
      console.log(`Skipped ${skipped.length} (remote/unsupported): ${skipped.join(", ")}`);
    }
  });

program
  .command("list")
  .description("List registered servers and their intended state")
  .action(() => {
    const reg = loadRegistry();
    const names = Object.keys(reg.servers);
    if (names.length === 0) return console.log("No servers registered.");
    for (const name of names) {
      const on = reg.servers[name].enabledFor;
      console.log(`${name}  ->  ${on.length ? on.join(", ") : "(disabled)"}`);
    }
  });

program
  .command("status")
  .description("Show which tools actually contain each server on disk")
  .action(() => {
    const rows = status();
    if (rows.length === 0) return console.log("No servers registered.");
    const mark = { on: "on ", off: " . ", err: "err" } as const;
    console.log(["server".padEnd(20), ...ALL_TOOLS].join(" | "));
    for (const row of rows) {
      const cells = ALL_TOOLS.map((t) => mark[row.state[t]]);
      console.log([row.name.padEnd(20), ...cells].join(" | "));
    }
    if (rows.some((r) => ALL_TOOLS.some((t) => r.state[t] === "err"))) {
      console.log('\n"err" = that tool\'s config file is unreadable; fix or remove it.');
    }
  });

program
  .command("sync")
  .description("Reapply the registry's intended state to all tool configs")
  .action(() => {
    sync();
    console.log("Synced registry to all tools.");
  });

try {
  program.parse();
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
