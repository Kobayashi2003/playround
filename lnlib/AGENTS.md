# lnlib

- The server (`server/`, run by `main.py`) uses the Python standard library only; keep it that way.
- The interface (`web/`) is React built with Vite.
- `web/src/epub-reader/` is a copy of `components/data-display/epub-reader`: change it upstream,
  then copy it back.
