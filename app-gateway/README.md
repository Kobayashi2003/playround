# app-gateway

Serves several apps behind one public port. A single Caddy on `:30709` routes by path prefix to
each app and supervises them all; apps not routed are only launched.

```
:30709 Caddy ─┬─ /          landing page
              ├─ /admin/    admin page (served by start.ps1 on localhost:16050)
              └─ /example-app  routed application

Local-only applications keep their own listener ports.
```

No app knows about the gateway: it starts each one exactly as it would run on its own.

## Run

Requires PowerShell 7 and Caddy on `PATH`. Run the commands in this section
from the project root.

For a new checkout, copy [gateway.example.json](gateway.example.json) to `gateway.json`.
Create `apps/` and select a template from [examples/apps/](examples/apps/). Copy it to
`apps/<id>.json` without `.example`, then fill in the real directory, ports and routes.
The examples directory is outside the live registry.

Keep `gateway.json`, `apps/*.json`, `gateway.auth.json` and generated files on the machine.
Use fictional values in tracked examples. Keep custom runtime, backup and log directories
outside Git or explicitly ignored.

> **Upgrading from an older checkout where `gateway.json` and `apps/*.json` were tracked:**
> Git will remove those tracked files when pulling this revision on a clean checkout.
> Back up `gateway.json` and `apps/*.json` before updating, then copy them back afterwards.
> If you already updated and lost them, restore them from the previous commit with
> `git checkout <previous-commit> -- gateway.json apps/` (and unstage if needed with
> `git restore --staged gateway.json apps/`). Untracking these files keeps future commits
> clean but does not remove earlier copies from existing Git history.

On the first start, any legacy admin credential in `gateway.json` moves to `gateway.auth.json`
and is removed from `gateway.json`. An existing credential file takes precedence.

```powershell
.\start.ps1                                # every enabled app
.\start.ps1 -App example-local             # just this app, enabled or not
.\start.ps1 -List                          # the registry
.\start.ps1 -ConfigOnly                    # generate and validate config, launch nothing
.\start.ps1 -Bind :8080                    # move the public port for this run
.\start.ps1 -Port example-local:http=16101 # move an app's port for this run (within its slot)
.\start.ps1 -Enable example-local          # / -Disable writes to that registration
.\start.ps1 -NoAdmin                       # no admin page this run
.\start.ps1 -SetAdminPassword              # prompt for a new admin password, store its hash
```

Every child's output passes through the gateway: to this console prefixed with its app id, to
`logs/<app>.log` (and `logs/caddy.log`, `logs/gateway.log`), and to the admin page. The folder
is `logs` in `gateway.json`; it holds disposable logs and `admin-audit.log`. Previous and
deleted app registrations are kept separately in `backups/` (`backups` in `gateway.json`), so
clearing `logs/` does not remove recovery history.

Ctrl+C stops everything; `.\stop.ps1` does the same from another window. An app that fails or
exits is reported and skipped; only Caddy exiting stops the gateway. An app whose declared ports
are already listening is left alone and not launched, unless its `launch.restartIfRunning` is
true: then its own `stop.ps1` runs first, and if the ports still do not free it is skipped. The landing page opens in
the browser unless `-NoBrowser`; apps are always started with `-NoBrowser`.

## Admin page

`/admin/` on the gateway's port, behind a sign-in. Set the password with
`.\start.ps1 -SetAdminPassword`. The local `gateway.auth.json` stores the account name
(default `admin`) and PBKDF2 hash. The page is served by `start.ps1` itself, from
`admin/` and `lib/AdminServer.ps1`, so it sees and steers the same processes the console does:

The admin console is one continuous page. Use the navigation to jump between sections
or scroll through them. Moving between sections retains the current editor draft,
filters, and log position. The theme menu supports Light, Dark and the system preference. Links to specific registrations and log sources still work.

- **Overview** — uptime, Caddy, app states, gateway events, disks, and the last hour of
  machine CPU and memory. The supervisor samples these every 10 seconds, each app's too, so
  the charts are there when the page opens. Recent activity shows four events on desktop and
  three on narrow screens. **View activity** opens the Gateway stream in Logs. The **More** menu
  includes **Apply routes**, **Start enabled apps**, **Restart live apps**, **Stop all apps**
  and **Shut down Gateway**.
- **Apps** — select a registration in the resource list to see its process, entry, ports,
  startup settings and live output together. Use the arrow keys to move between resources,
  or the application picker on a narrow screen. A link such as `#apps/app/sample` opens
  that application directly. On wide screens, recent output sits beside the properties.
  At smaller widths it moves below them. Scroll up in **Recent output** to read earlier lines, then choose
  **Jump to latest** to follow the tail. Starting an app this run did not include adds its route
  to Caddy on the fly. Restart takes over a copy started elsewhere through its own `stop.ps1`.
  Route probes check live entries with `HEAD` (falling back to `GET` on `405`/`501`) and can be
  re-run on demand with **Re-check**.
- **Logs** — live tail of every source interleaved, or one app, Caddy or the gateway alone;
  errors and warnings highlighted, with filter, pause, copy, clear and download (including
  **All sources**). Structured Caddy JSON lines are summarized by default; enable **Raw JSON**
  to inspect the full JSON payloads. Output wraps by default; turn off **Wrap lines** to scroll
  wide lines horizontally.
- **Config** — create local-launch, managed-proxy or proxy-only registrations. Edit common
  fields (including sort order, startup/visibility flags and launch policies) or switch to
  **Raw JSON** with live JSON validation, `Tab` indentation, `Ctrl+S` save and **Format JSON**.
  Check the resolved root, ports and icon, then save to disk. Edits mark the previous check out
  of date. **Gateway files** contains `gateway.json` and `Caddyfile`. **Reference** contains
  variables, the schema and `PORTS.md` (with one-click copy). Restore drafts from History
  (`backups/`). **Apply routes** re-reads `gateway.json` and the registry,
  validates and stages a candidate, and switches the directory and routes after Caddy accepts
  it. A running app picks up new startup parameters on its next start. For managed routed
  ports, **Apply and restart** waits for the app to listen on the new ports before switching
  the route, and restores the prior launch on failure. Stop externally managed apps yourself.
- **Ports** — every listener in the PORTS.md ranges, who declares it and which process holds it.
  Select a range, filter by port, app or process, and combine with **Unclaimed only**. Click a
  declared app name to open its details. On narrow screens, expand a port number to see its
  slot, process and bindings.
- **Security** — inspect sessions, expand browser details, change your password and filter the
  audit log. Active lockouts appear above sessions with their expiration and a clear action.
  Audit events are stored in `logs/admin-audit.log`.

The header shows the fleet's health. Select the status to locate the affected apps or the
gateway overview. Open the command palette with `Ctrl+K` to find an application by name,
inspect it or run a command. App commands show the same registered icon as the resource list.

Writes need the session's CSRF token; five failed sign-ins from one client lock it out for 15
minutes, thirty from everyone close sign-in for all. Sessions are kept in memory, so a gateway
restart signs everyone out. An app with `launch.autoRestart` is started again after a crash,
with backoff, up to five times in ten minutes.

## Apps

Each `apps/<id>.json` registers one app; `schema/app.schema.json` documents every field. A
routed app that knows nothing about Caddy looks like this:

```json
{
  "$schema": "../schema/app.schema.json",
  "name": "Example app",
  "root": "${paths.workspace}/example-app",
  "basePath": "/example-app",
  "ports": { "http": 16110 },
  "routes": { "proxy": [ { "upstream": "127.0.0.1:${ports.http}" } ] },
  "launch": { "args": ["-Port", "${ports.http}", "--base-path", "${basePath}"] }
}
```

`launch` runs the app's own `start.ps1` with `args`; leave it out for an app that is only routed.
A launched app with no `basePath` gets a row under **On this machine** on loopback.
It opens `http://127.0.0.1:<lowest port>/` by default. Use
`"localEntry": { "port": "http", "path": "/" }` to choose a named port and a path.

`paths` in `gateway.json` maps aliases to directories relative to the gateway directory.
Variables resolve in order: `${id}`, `${bind}` and `${paths.NAME}`, then absolute `${root}`,
optional `${basePath}` and numeric `${ports.NAME}`. Launch arguments, environment values,
descriptions, probes and route fields can use these variables. Substitution is single-pass,
with an error for unknown variables. Names and icon paths are literal. `gateway.json` also
names [PORTS.md](../../PORTS.md) and the generated asset directory (`runtime`, default `.runtime/`).

Use `"icon": "◇"` for a glyph or `"icon": { "file": "static/icon.svg" }` for an app-owned image.
Set the file path relative to the registered app's filesystem root, using forward slashes.
Choose the source asset used for the site's favicon, for example `frontend/src/app/icon.png`
for a Next.js app with that layout. Static SVG and PNG files up to 128 KiB are supported.
PNG dimensions are limited to 512 × 512. **Config → Registry → Check** previews the file.
Save the registration and use **Apply routes** after changing the path or replacing the image.

Public routed entries use a content-hashed copy on the landing page. The public HTML
includes only routed entries; on the gateway host, **On this machine** is fetched from
`/admin/api/local-apps` (enforced loopback-only on the server), which loads local app icons
via loopback-only `/admin/api/local-icons/<id>` and attaches live states for signed-in admin
sessions. Signed-in admin sessions also see live status badges on routed cards via
`/admin/api/session?status=1`. Press `/` on the landing page to focus search, or click any
card to open it. Hidden apps stay out of the directory.

Ports follow PORTS.md. An app takes every slot from its lowest port to its highest. Before
launching, the gateway rejects a port outside the app's range or slots, two apps in one slot,
a port claimed twice, and overlapping `basePath` prefixes.

## Adding an app

1. Take the lowest free slot in the `PORTS.md` of the app's directory (ranges in the root
   [PORTS.md](../../PORTS.md)) and make it the app's default.
2. If it is routed, make it serve under a path prefix: relative asset URLs, API calls resolved
   against the document, and a redirect from the bare prefix to the trailing-slash form. Bind
   `127.0.0.1`.
3. Give it a `start.ps1` (see `Code/AGENTS.md`), then add `apps/<id>.json` with `ports`,
   `launch`, and either `routes.proxy` (the gateway writes the route) or `routes.snippet` (the
   app's own `Caddyfile.snippet`, plus `routes.env` for its variables). An app that is only
   launched leaves out `basePath` and `routes`.

Every snippet is imported into one site block, so a snippet must not contain a matcher-less
`handle`, and its named matchers must carry the app's prefix (`@example_*`).

An app whose `start.ps1` runs its own Caddy is given `-NoCaddy` in `launch.args`, so only the
gateway's Caddy binds. `:30709` belongs to the gateway.
