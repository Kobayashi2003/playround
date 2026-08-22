# mcphub (`mcpm`)

A small CLI to toggle MCP servers on/off across **VS Code**, **Cursor**,
**Claude Code** and **Codex** from one place.

The tool keeps its own registry (`~/.mcp-manager/registry.json`) as the single
source of truth, and syncs each server's on/off state into every tool's own
config file — abstracting away their different formats (JSON, JSONC, TOML) and
key names. Every config write is backed up first.

## Install

```sh
npm install
npm run build
npm link   # exposes the `mcpm` command
```

## Usage

```sh
# register a server definition
mcpm add fs -c npx -a -y -a @modelcontextprotocol/server-filesystem -a D:/data -e TOKEN=abc

mcpm enable fs                    # turn on in all tools
mcpm enable fs --for cursor,codex # or specific tools
mcpm enable fs --dry-run          # preview changes without writing
mcpm disable fs --for vscode
mcpm import cursor                # adopt servers already configured in a tool
mcpm import cursor fs             # ...or just one
mcpm list                         # intended state (from registry)
mcpm status                       # actual state (read from each tool's config)
mcpm sync                         # reapply registry to all configs
mcpm rm fs                        # remove everywhere
```

Every config write is backed up first (newest 5 kept per file). A tool whose
config is unreadable shows as `err` in `status` and never blocks the others;
enabling/disabling refuses to touch a corrupt file. Remote (url-based) servers
are not modeled yet and are skipped on `import`.

Tool ids: `claude-code`, `cursor`, `vscode`, `codex`.

> Restart the affected tool after a change — none of them hot-reload MCP config.

## Managed config locations (Windows, global scope)

| Tool | Path | Format |
|------|------|--------|
| Claude Code | `~/.claude.json` | JSON |
| Cursor | `~/.cursor/mcp.json` | JSON |
| VS Code | `~/AppData/Roaming/Code/User/mcp.json` | JSONC |
| Codex | `~/.codex/config.toml` | TOML |
