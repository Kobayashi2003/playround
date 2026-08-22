# app-gateway

One public port, several apps.

Only a single HTTPS port is reachable through the tunnel, but there is more than
one app to serve and each would like to own the origin root. The gateway runs a
single Caddy on that port (`:30709`) and fans out by path prefix, supervising
every app beside it.

```
tunnel (one HTTPS port) ──▶ :30709 Caddy ─┬─ /                    landing page
                                          ├─ /hearth              Hearth
                                          ├─ /simple-file-server  Simple File Server
                                          ├─ /vndb                Visual Novel Database
                                          ├─ /chatlog             Chat Log Viewer
                                          └─ /lnlib               蔵書棚
```

## An app is a file

`apps/` **is** the registry. One `*.json` file is one app, and the file name is
its id.

```
apps/
  hearth.json
  simple-file-server.json
  visual-novel-database.json
  chatlog-viewer.json
  lnlib.json
```

Copy a file in and that app is registered. Delete it and it is gone. There is no
list to update, so there is nothing that can disagree with what is actually in
the directory — and no app's name, port, prefix or icon appears anywhere in the
code. `schema/app.schema.json` documents every field; point an editor at it and a
plugin file completes and validates itself.

```json
{
  "$schema": "../schema/app.schema.json",
  "name": "Chat Log Viewer",
  "icon": "🗯",
  "root": "${paths.playround}/chatlog-viewer",
  "basePath": "/chatlog",
  "ports": { "http": 8777 },
  "routes": { "proxy": [ { "upstream": "127.0.0.1:${ports.http}" } ] },
  "launch": {
    "file": "python",
    "args": ["server.py", "--port", "${ports.http}", "--base-path", "${basePath}", "--no-open"]
  }
}
```

Every string expands against `${id}`, `${root}`, `${basePath}`, `${bind}`,
`${paths.NAME}` and `${ports.NAME}` before use. An unknown name is an error, not
an empty string — a typo would otherwise become an upstream of `127.0.0.1:` that
Caddy accepts and nothing ever answers.

`gateway.json` holds only what belongs to the gateway itself: the bind address,
the landing page's chrome, the named `paths` app files resolve their roots
against, and which directory to scan. No app is described there.

## Usage

```powershell
.\gateway.ps1                            # every enabled app
.\gateway.ps1 -App hearth,lnlib          # just these, enabled or not
.\gateway.ps1 -List                      # the registry, and what is on
.\gateway.ps1 -ConfigOnly                # generate and validate config, launch nothing
.\gateway.ps1 -Bind :8080                # move the public port, this run
.\gateway.ps1 -Port hearth:backend=5200  # move an app's port, this run
.\gateway.ps1 -Enable lnlib              # turn an app on, written back to apps/lnlib.json
.\gateway.ps1 -Disable lnlib             # turn it off again
.\gateway.ps1 -Config other.json         # different settings, and its own appsDir
```

Ctrl+C stops everything: Windows fans the signal out to the whole console
process group, so each launcher runs its own shutdown. A `taskkill /T` backstop
catches the case where the gateway was killed externally.

### Control

| Want | Do |
|------|----|
| Unregister an app entirely | delete (or move) its file |
| Keep it registered but dormant | `-Disable <id>`, or `"enabled": false` |
| Run one app on its own, just this once | `-App <id>` |
| Change where an app listens | edit its `ports`, or `-Port <id>:<name>=<n>` |
| Reorder the landing page | edit `order` |
| Change the public port | edit `bind` in `gateway.json`, or `-Bind` |
| Move a checkout | edit `paths` in `gateway.json` |
| Keep a whole second registry | another settings file with its own `appsDir` |

`-Enable` / `-Disable` rewrite that one app's file and nothing else, which is the
other half of why an app gets its own file.

### Ports

`ports` is what lets the gateway *place* an app rather than merely discover it.
A number is written once and reaches two places from there: the app itself (as a
launch argument, or through `env`) and the route that proxies to it. They cannot
drift apart, because there is only one of them.

That also makes collisions visible. Hearth and Simple File Server both default
to `5111` standalone, which never mattered while only one of them ran at a time;
together they would have raced for the port and one would have died with a
message in its own log. The gateway refuses to start instead, naming both:

```
Port 5111 is claimed by both 'hearth/backend' and 'simple-file-server/backend'.
```

The same check covers an app that claims the gateway's own bind, and overlapping
`basePath` prefixes.

For an app the gateway launches directly, the port goes on the command line. For
one with a launcher of its own, it goes through `env`, and the project's
`caddy-env.ps1` gives that variable precedence over its `.env` — so the app and
the edge agree, and a bare `npm run dev` with no gateway in sight still reads
`.env` exactly as before.

### Two kinds of routing

**`routes.snippet`** — the project keeps a `Caddyfile.snippet` and the gateway
imports it, the same file the project's own standalone `Caddyfile` imports.
Routes are written once and appear in both modes. This is for an app whose
routing is genuinely its own business: auth gates, cache fast-paths, five
backends. `routes.env` names the script that supplies the variables the snippet
expands; it lives in the project because the project owns where it listens.

**`routes.proxy`** — the app knows nothing about Caddy, so the gateway writes the
route: a matcher on its prefix and a `reverse_proxy` to the port it was given.
This is what lets a plain HTTP server join without being taught anything about
edges or snippets.

## Adding an app

An app has to be reachable under a **path prefix**, because the origin root
belongs to the landing page here. That is the one thing it must know about
itself; everything else is a file in `apps/`.

1. Give it a prefix it can serve under — a build-time `basePath` for Next.js, a
   runtime flag for anything else. Assets referenced relatively, API calls
   resolved against the document's own directory, and a redirect from the bare
   prefix to the trailing-slash form. `chatlog-viewer` and `lnlib` are the
   smallest worked examples: `--base-path`, about thirty lines between them.
2. Bind loopback, so the edge is the only way in.
3. Drop `apps/<id>.json` in with `ports`, `routes.proxy` and `launch`.

For an app with real routing needs, swap step 3 for a `Caddyfile.snippet` and a
`caddy-env.ps1` in the project, and point `routes.snippet` at them. Two rules
apply to a snippet, because every app's snippet is imported into **one** site
block:

- no matcher-less `handle` — the catch-all is the landing page, and one here
  would swallow every other app's traffic;
- prefix named matchers with the app (`@hearth_*`) — matcher names are scoped to
  that shared site block.

Nothing else. The Caddyfile and the landing page are both generated.

## Two launch modes

Each project still runs **standalone** — its own `start*.ps1` boots its own Caddy
on `:30709`. The gateway runs them **together** behind one shared Caddy instead,
passing `-NoCaddy` to each launcher so only one process owns the port.

The two modes cannot run at once, because they want the same port. That is the
point: the tunnel always targets `:30709` and never needs reconfiguring. The
gateway says so plainly when the port is taken, rather than letting Caddy fail to
bind and bury the reason in its JSON log.

## Layout

| Path | Purpose |
|------|---------|
| `apps/*.json` | The registry. One file per app; the file name is the id. |
| `gateway.json` | The gateway's own settings. No app appears here. |
| `schema/app.schema.json` | What a plugin's fields mean. JSON has no comments; this is where they went. |
| `schema/gateway.schema.json` | The same, for the settings file. |
| `gateway.ps1` | Entry point: discover, resolve, generate, validate, supervise. |
| `lib/Config.ps1` | Plugin discovery, validation and placeholder expansion. |
| `lib/CaddyBuilder.ps1` | Compose the runtime Caddyfile from snippets and proxy rules. |
| `lib/LandingBuilder.ps1` | Render the landing page from the same records. |
| `lib/ProcessHost.ps1` | Child spawn / wait / teardown, and scoped environments. |
| `.runtime/` | Generated each launch. Not committed, never edited by hand. |

`-ConfigOnly` writes `.runtime/` and runs `caddy validate` over it without
starting anything — a broken snippet or a route variable nobody supplies is
found there, rather than after every app has already been launched.
