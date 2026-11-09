# Remote Wake

An ESP32-S3-Zero on USB power keeps a WebSocket open to a Cloudflare relay and
sends Wake-on-LAN packets to the PC's wired adapter when the web page asks. It
also watches its USB link to tell whether the PC is on, asleep or off. An agent
on the awake PC runs further actions (shut down, sleep, lock, or your own)
through the same board.

```
browser ─ Pages entry ─ Worker + Durable Object ═ WebSocket ═ board ─ Wake-on-LAN ─ PC
                                                               └── USB HID ── tools/agent.py
```

## Use

Open <https://personal-usb-wake-entry.pages.dev/> and sign in with
`ACCESS_PASSWORD`. On a phone, add it to the home screen to use it like an app.

- **Wake PC** sends the packets and follows the wake until the PC reports on
  (or two minutes pass).
- **PC** shows the power state and one button per agent action; actions marked
  `confirm` need a second tap.
- **Activity** lists recent events, including a PC restart that did not come
  from the page and the board going offline.
- **Scheduled wake** wakes the PC at set times (in `TIMEZONE`, default
  Asia/Shanghai, set in `cloud/wrangler.jsonc`) unless it is already on.
- **Wake board** shows temperature, Wi-Fi signal, uptime and firmware build,
  and sets the LED brightness (Off still flashes when the BOOT button wakes).

The board, router and Ethernet adapter must stay powered while the PC sleeps.
The board's BOOT button also wakes the PC. Set `NOTIFY_URL` (see Deploy) to get
wakes, failed actions, unexpected restarts and board outages on your phone.

## Layout

| Path           | Contents                                                        |
| -------------- | --------------------------------------------------------------- |
| `cloud/`       | Worker and Durable Object (`src/`), secrets template, root CAs  |
| `pages-entry/` | Pages proxy that forwards everything to the Worker              |
| `web/`         | The page and app icons; bundled by `scripts/build.mjs`          |
| `firmware/`    | PlatformIO project; tunables in `src/config.h`                  |
| `tools/`       | Python: board protocol, agent, status, OTA, Wi-Fi setup, deploy |
| `agent.toml`   | Actions the PC agent offers                                     |
| `test/`        | Node relay tests and pytest suites                              |

## PC agent

```powershell
uv run tools/agent.py --check     # Validate agent.toml
./install_agent.ps1               # Logon task for this user; starts it now
./install_agent.ps1 -Uninstall
```

Add an action by appending an `[[action]]` to `agent.toml` (the file documents
each field), then rerun `./install_agent.ps1`. The agent uses only USB. It runs in
the signed-in session, so after a restart only waking works until you sign in.
Hibernate needs `powercfg /h on` once. Log: `.logs/agent.log`; the last handled command is
kept in `.agent-state.json`. `USB_WAKE_LOG_DIR` and `USB_WAKE_STATE_FILE` move them (relative to
this folder; set them as user environment variables, since the logon task does not see a
shell's). `start.ps1` writes its logs to the same folder.

## Board

```powershell
uv run tools/status.py                    # Network, cloud, target, board, agent
uv run tools/status.py --target-mac 58:11:22:AB:1C:C8
uv run tools/status.py --wake
./start.ps1 -Mode Setup                   # Wi-Fi setup page on http://127.0.0.1:16032/
```

Build with `uvx --from platformio platformio run` in `firmware/`; each build is
stamped with its UTC time. Update the board over the air with:

```powershell
uv run tools/ota.py               # Uploads the build, waits for the board, withdraws the offer
```

The board verifies the image's SHA-256, and a new build that cannot reach the
relay within five minutes rolls back to the previous one. To flash over USB
instead, run `uv run tools/status.py --bootloader`, then
`uvx --from platformio platformio run --target upload --upload-port <COM port>`.
Saved Wi-Fi and target MAC survive both. For recovery, hold BOOT, tap RESET,
release BOOT. `backups/` holds flash images, including Wi-Fi credentials; keep
them private.

## Develop

```powershell
pnpm install; uv sync
./start.ps1 -Build      # Local relay on http://127.0.0.1:16030/
./stop.ps1
pnpm lint; pnpm format:check; pnpm test
uv run ruff check; uv run ruff format --check; uv run basedpyright; uv run pytest
```

The local relay has its own state; the board always talks to production.

## Deploy

Secrets live in `cloud/.dev.vars` (gitignored; see `cloud/.dev.vars.example`):
ADMIN_TOKEN, DEVICE_TOKEN, ACCESS_PASSWORD and the optional NOTIFY_URL. After
changing them:

```powershell
uv run tools/prepare_cloud.py     # Writes cloud/.secrets.json and the firmware's cloud_settings.h
pnpm exec wrangler secret bulk cloud/.secrets.json --config cloud/wrangler.jsonc
```

Then deploy and check:

```powershell
pnpm deploy
uv run tools/verify_cloud.py      # No commands sent
uv run tools/remote_test.py       # Sends one real wake
```

A new password or NOTIFY_URL needs only the secret upload. A new device token,
relay URL or CA bundle also needs a firmware rebuild and USB flash. The Worker
has no `workers.dev` route; to update the Pages proxy, run
`pnpm exec wrangler pages deploy public --project-name personal-usb-wake-entry`
in `pages-entry/`. The relay still accepts HTTP polling (`/device/poll`) so that
older firmware, such as a restored backup, keeps working.
