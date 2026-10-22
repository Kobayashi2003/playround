# playround

Small personal apps, one folder each. Apps that listen take a slot in
`16000–16999` ([PORTS.md](../PORTS.md)).

| Folder | What it is | Ports |
|---|---|---|
| [app-gateway](app-gateway/) | Serves several apps behind one public port | 16000 reserved (itself binds 30709) |
| [chatlog-viewer](chatlog-viewer/) | Reads Claude Code and Codex session logs in the browser | 16010 http |
| [collection-tree](collection-tree/) | Browsable HTML trees of selected collection folders, built from Everything | 16040 http |
| [epub-finder](epub-finder/) | Desktop full-text search over a folder of EPUBs | — |
| [lnlib](lnlib/) | Bookshelf and in-browser reader for a light novel and manga collection | 16020 serve · 16021 Vite dev |
| [usb-wake](usb-wake/) | ESP32 Wi-Fi Wake-on-LAN controller with a free Cloudflare relay | 16030 Worker dev · 16031 Pages dev · 16032 local setup · 16033 isolated tests · 16034–16035 inspectors |

Free slots: 16050 and up.
