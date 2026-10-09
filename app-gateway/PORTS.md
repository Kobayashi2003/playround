# Ports

Every app of mine that listens on a port — under `playround/`, `project/`,
`sites/` and `tools/Crawler/` — takes its ports from this table, so any of them can run at the
same time as any other without anyone coordinating. `portRanges` in
`gateway.json` is the machine-readable half; the gateway checks its registry
against it before launching anything.

## Why 16000 and up

This machine's TCP dynamic range is 1024–15000
(`netsh int ipv4 show dynamicport tcp`), and WinNAT reserves blocks of 100 inside
it that move between boots (`netsh int ipv4 show excludedportrange protocol=tcp`).
A port below 15000 can bind today and fail with a permission error tomorrow.
15001–49151 is outside both this range and the Windows default (49152–65535).

## Rules

- Each directory owns a range; each app owns one **slot of ten** in it, counted
  from the start of the range. Offset +0 is the app's main entry point.
- Spare ports in a slot are that app's room to grow, not free for others. An app
  that needs more than ten takes consecutive slots, noted below.
- Every project under `project/` has a slot, listening or not. Elsewhere only apps
  that listen get one.
- Append only: a new app takes the next free slot; a removed app's slot is
  retired, not reused.
- The app's own defaults — code, `.env`, example configs, docs, tests — sit in its
  slot, so it lands there with no launcher involved. It binds `127.0.0.1`, and if
  it steps past a taken port it stays inside its slot.

A project's own edge (its standalone Caddy) is one of its ports like any other.

Not covered: `30709`, the tunnel's public port, which belongs to the gateway (a
project can be put there for a while with its launcher's `-Bind`); and
infrastructure apps only connect to — PostgreSQL, Redis, Everything, Clash.

## Allocation

| Range | Slot | App | Ports |
|---|---|---|---|
| playround 16000–16999 | 16000 | app-gateway | reserved (itself binds 30709) |
| | 16010 | chatlog-viewer | 16010 http |
| | 16020 | lnlib | 16020 serve · 16021 Vite dev |
| project 17000–17999 | 17000 | EasyPwsh | reserved |
| | 17010 | Hearth | 17010 backend · 17011 Vite dev · 17012 standalone edge |
| | 17020 | NeoDesk | reserved |
| | 17030 | NeoVNDB | 17030 edge · 17031 read API · 17032 image mirror · 17033 users · 17034 Next |
| | 17040 | VisualNovelDatabase | 17040 Next · 17041 vndbserve · 17042 imgserve · 17043 userserve · 17044 transserve · 17045 musicserve · 17046 logserve · 17047–17048 Flower (vndbserve, imgserve) · 17049 standalone edge |
| Crawler 18000–18999 | 18000–18029 | jable-downloader | Clash pool: instance *i* takes 18000+3*i* (HTTP), +1 (SOCKS), +2 (controller); at most 10 instances |
| | 18030 | novelia-downloader-v2 | 18030 serve · 18031 `tests/ui_preview.py` |
| | 18040 | tmw-downloader-v2 | 18040 http, stepping up to 18049 if taken |
| | 18050 | fc2-sukebei-browser | 18050 serve |
| sites 19000–19999 | 19000 | component-atlas | 19000 Vite dev · 19001 Vite preview |
| | 19010 | site-atlas | 19010 vinext dev · 19011 production server (`pnpm start`) |

Apps that do not listen get no slot: epub-finder, and the other crawlers. A site
under `sites/` that is shown through Site Atlas runs inside it and gets no slot
of its own.
