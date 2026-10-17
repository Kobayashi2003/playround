# app-gateway

Serves several apps behind one public port. A single Caddy on `:30709` routes by path prefix to
each app and supervises them all; apps not routed are only launched.

```
:30709 Caddy ─┬─ /          landing page
              ├─ /hearth    Hearth
              └─ /chatlog   Chat Log Viewer
```

No app knows about the gateway: it starts each one exactly as it would run on its own.

## Run

Requires PowerShell 7 and Caddy on `PATH`.

```powershell
.\gateway.ps1                              # every enabled app
.\gateway.ps1 -App hearth,chatlog-viewer   # just these, enabled or not
.\gateway.ps1 -List                        # the registry
.\gateway.ps1 -ConfigOnly                  # generate and validate config, launch nothing
.\gateway.ps1 -Bind :8080                  # move the public port for this run
.\gateway.ps1 -Port hearth:backend=17019   # move an app's port for this run (within its slot)
.\gateway.ps1 -Enable tmw-downloader       # / -Disable: written back to apps/tmw-downloader.json
```

Ctrl+C stops everything; `.\stop.ps1` does the same from another window. The landing page opens in
the browser unless `-NoBrowser`; apps are always started with `-NoBrowser`.

## Apps

Each `apps/<id>.json` registers one app; `schema/app.schema.json` documents every field.

```json
{
  "$schema": "../schema/app.schema.json",
  "name": "Chat Log Viewer",
  "root": "${paths.playround}/chatlog-viewer",
  "basePath": "/chatlog",
  "ports": { "http": 16010 },
  "routes": { "proxy": [ { "upstream": "127.0.0.1:${ports.http}" } ] },
  "launch": { "args": ["-Port", "${ports.http}", "--base-path", "${basePath}"] }
}
```

`launch` runs the app's own `start.ps1` with `args`; leave it out for an app that is only routed.

Strings expand `${id}`, `${root}`, `${basePath}`, `${bind}`, `${paths.NAME}` and
`${ports.NAME}`; an unknown name is an error. `gateway.json` holds the gateway's own settings:
bind address, landing page text, named `paths`, and where [PORTS.md](../../PORTS.md) is.

Ports follow PORTS.md. Before launching, the gateway rejects a port outside the app's range or
slot, two apps in one slot, a port claimed twice, and overlapping `basePath` prefixes.

## Adding an app

1. Take the next free slot in [PORTS.md](../../PORTS.md) and make it the app's default.
2. If it is routed, make it serve under a path prefix: relative asset URLs, API calls resolved
   against the document, and a redirect from the bare prefix to the trailing-slash form. Bind
   `127.0.0.1`.
3. Give it a `start.ps1` (see `Code/AGENTS.md`), then add `apps/<id>.json` with `ports`,
   `launch`, and either `routes.proxy` (the gateway writes the route) or `routes.snippet` (the
   app's own `Caddyfile.snippet`, plus `routes.env` for its variables). An app that is only
   launched leaves out `basePath` and `routes`.

Every snippet is imported into one site block, so a snippet must not contain a matcher-less
`handle`, and its named matchers must carry the app's prefix (`@hearth_*`).

An app whose `start.ps1` runs its own Caddy is given `-NoCaddy` in `launch.args`, so only the
gateway's Caddy binds. `:30709` belongs to the gateway.
