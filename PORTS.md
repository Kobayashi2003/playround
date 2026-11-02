# playround ports

Range `16000–16999`, in slots of 10; the rules are in the root
[PORTS.md](../PORTS.md).

| Project | Slot | Ports |
|---|---|---|
| app-gateway | 16000–16009 | reserved (the gateway itself binds 30709) |
| chatlog-viewer | 16010–16019 | 16010 http |
| lnlib | 16020–16029 | 16020 serve · 16021 Vite dev |
| usb-wake | 16030–16039 | 16030 Worker dev · 16031 Pages dev · 16032 local setup · 16033 isolated tests · 16034–16035 inspectors |
| collection-tree | 16040–16049 | 16040 http |

Lowest free slot: 16050.
