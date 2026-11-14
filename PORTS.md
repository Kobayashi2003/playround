# playround ports

Range `16000–16999`, in slots of 10; the rules are in the root
[PORTS.md](../PORTS.md). app-gateway listens only on 30709, which no range covers, and
has no slot.

| Project | Slot | Ports |
|---|---|---|
| nas-deck | 16000–16009 | 16000 local end of the SSH tunnel to the agent, which listens on the same port on the NAS's loopback |
| chatlog-viewer | 16010–16019 | 16010 http |
| lnlib | 16020–16029 | 16020 serve · 16021 Vite dev |
| usb-wake | 16030–16039 | 16030 Worker dev · 16031 Pages dev · 16032 local setup · 16033 isolated tests · 16034–16035 inspectors |
| collection-tree | 16040–16049 | 16040 http |

Lowest free slot: 16050.
