# app-gateway

One public port, several apps.

Only a single HTTPS port is reachable through the tunnel, but there is more than
one app to serve and each would like to own the origin root. The gateway runs a
single Caddy on that port (`:30709`) and fans out by path prefix, supervising
every app beside it.

```
tunnel (one HTTPS port) ──▶ :30709 Caddy ─┬─ /                    landing page
                                          ├─ /hearth              Hearth
                                          ├─ /vndb                Visual Novel Database
                                          ├─ /chatlog             Chat Log Viewer
                                          └─ /lnlib               蔵書棚

launched, not routed (each listens on its own loopback port):
  NeoVNDB · Novelia Downloader · TMW Downloader
```

No app knows the gateway is there. Each one is configured and started exactly as
it would be on its own; the gateway only reads what it already offers — a start
script, a port setting, a `Caddyfile.snippet` — and nothing in any app's
repository names the gateway.

## An app is a file

`apps/` **is** the registry. One `*.json` file is one app, and the file name is
its id.

```
apps/
  hearth.json
  visual-novel-database.json
  chatlog-viewer.json
  lnlib.json
  neovndb.json               (off by default)
  novelia-downloader.json    (off by default)
  tmw-downloader.json        (off by default)
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
  "ports": { "http": 16010 },
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
against, the port range each of those directories owns, and which directory to
scan. No app is described there.

## Usage

```powershell
.\gateway.ps1                              # every enabled app
.\gateway.ps1 -App hearth,lnlib            # just these, enabled or not
.\gateway.ps1 -List                        # the registry, and what is on
.\gateway.ps1 -ConfigOnly                  # generate and validate config, launch nothing
.\gateway.ps1 -Bind :8080                  # move the public port, this run
.\gateway.ps1 -Port hearth:backend=17019   # move an app's port, this run
.\gateway.ps1 -Enable lnlib                # turn an app on, written back to apps/lnlib.json
.\gateway.ps1 -Disable lnlib               # turn it off again
.\gateway.ps1 -Config other.json           # different settings, and its own appsDir
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
| Change where an app listens | within its slot: edit the app's own config and its `ports` here; or `-Port <id>:<name>=<n>` for one run |
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

The numbers themselves come from one convention, [PORTS.md](PORTS.md): every
directory of apps owns a range (`portRanges` in `gateway.json`), every app one
slot of ten inside it, and the app's own configuration already defaults to the
numbers its slot gives it. So `ports` here repeats what the app would pick
anyway — the gateway passing it on changes nothing, and running the app without
the gateway lands it on the same ports.

The gateway holds the registry to that convention before it launches anything,
naming the app and the rule it broke:

```
App 'lnlib' port 'http' is 17025, outside 16000-16999, the range of 'playround' where it lives. See PORTS.md.
App 'hearth' port 'backend' is 17020, outside its own slot 17010-17019. See PORTS.md.
Apps 'hearth' and 'other' both take the slot 17010-17019. One app, one slot. See PORTS.md.
Port 17010 is claimed by both 'hearth/backend' and 'other/backend'.
```

The same checks cover an app that claims the gateway's own bind, and overlapping
`basePath` prefixes. A slot is the app's own file's: `-Port` can move a port for
one run, but only within it.

For an app the gateway launches directly, the port goes on the command line. For
one with a launcher of its own, it goes through `env`, and the project's
`caddy-env.ps1` gives that variable precedence over its `.env` — so the app and
the edge agree, and a bare `pnpm dev` with no gateway in sight still reads
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

First give it a slot: the next free one in its directory's range, recorded in
[PORTS.md](PORTS.md), and make the app's own configuration default to it.

An app that only needs starting — it has its own edge, or is a local tool used on
this machine — stops there: drop `apps/<id>.json` in with `ports`, `env` or
arguments that hand them over, and `launch`, and leave out `basePath` and
`routes`. NeoVNDB and the crawler pages are registered that way.

An app fronted on the public port has to be reachable under a **path prefix**,
because the origin root belongs to the landing page here. That is the one thing
it must know about itself; everything else is a file in `apps/`.

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
in its own slot (Hearth `:17012`, Visual Novel Database `:17049`). The gateway
runs them **together** behind one shared Caddy on `:30709` instead, passing
`-NoCaddy` to each launcher so their edges stay down.

`:30709` is the tunnel's port and belongs to the gateway alone. To put a single
project on the tunnel without the gateway, start it with `-Bind :30709`; the
gateway then says plainly that the port is taken, rather than letting Caddy fail
to bind and bury the reason in its JSON log. The two modes still cannot run the
same app at once — its backend ports are the same either way.

## Layout

| Path | Purpose |
|------|---------|
| `PORTS.md` | The port convention and the slot table, for every app in the three directories. |
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
