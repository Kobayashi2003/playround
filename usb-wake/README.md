# Remote Wake

ESP32-S3-Zero controller powered by USB. It connects to 2.4 GHz Wi-Fi, polls a
Cloudflare relay, and sends Wake-on-LAN packets to the PC's wired adapter.

## Use

Open <https://personal-usb-wake-entry.pages.dev/> and select **Wake PC**.
The board, router and Ethernet adapter must stay powered during hibernation.
BOOT also sends a wake request; RESET preserves saved settings.

Access is currently passwordless. **Settings** can enable, change or disable a
password using the management key in `cloud/CONTROL-ACCESS.txt`. Settings changes
invalidate sessions. “Wake packets sent” confirms transmission, not PC resume.

## Develop

```powershell
pnpm install
uv sync
./start.ps1 -Build          # http://127.0.0.1:16030/; drop -Build once the assets are built
./stop.ps1
```

The board stays on production; local development state is separate. Logs are in
`.logs/`. Tests use fixture credentials and do not contact the real board.

```powershell
pnpm lint
pnpm format:check
pnpm test                  # Includes build and 30-second command expiry
uv run ruff check
uv run ruff format --check
uv run basedpyright
uv run pytest
```

## Board tools

```powershell
uv run status.py
uv run status.py --wake
./start.ps1 -Mode Setup     # http://127.0.0.1:16032/; closes after setup
```

Wi-Fi credentials are written over USB and stored on the board. Firmware uses
verified HTTPS, five-second polling, 30-second command expiry and persisted
command IDs to prevent duplicate sends.

To build firmware, run `uvx --from platformio platformio run` inside `firmware/`.
`uv run status.py --bootloader` enters the ROM downloader. Upload with PlatformIO's
`run --target upload --upload-port <COM port>`. For physical recovery, hold BOOT,
press and release RESET, then release BOOT.

## Deploy

```powershell
pnpm deploy
uv run verify_cloud.py https://personal-usb-wake-entry.pages.dev
# Sends one real wake request:
uv run remote_test.py https://personal-usb-wake-entry.pages.dev
```

Worker `personal-usb-wake` owns the SQLite Durable Object and secrets. Pages
`personal-usb-wake-entry` forwards requests through the RELAY service binding.
Both use the Free plan. To update that proxy, run `pnpm exec wrangler pages deploy
public --project-name personal-usb-wake-entry` from `pages-entry/`.

For initial provisioning or credential rotation, place ADMIN_TOKEN and
DEVICE_TOKEN in `cloud/.dev.vars`, then run:

```powershell
uv run prepare_cloud.py https://personal-usb-wake-entry.pages.dev cloud/root-ca.pem
pnpm exec wrangler secret bulk cloud/.secrets.json --config cloud/wrangler.jsonc
```

The first key manages access settings; the second authenticates the board.
Rebuild and flash after changing the firmware endpoint, device key or CA bundle.
Regular cloud deployments retain secrets and need no firmware update.

Private files and generated firmware are ignored by Git. `backups/` contains
factory and working flash backups, including saved Wi-Fi credentials; retain
them for recovery and do not publish them.
