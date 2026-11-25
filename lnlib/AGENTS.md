# lnlib

- The server (`server/`, run by `main.py`) uses the Python standard library only; keep it that way.
- The interface (`web/`) is React built with Vite.
- `web/src/epub-reader/` contains lnlib's copy of EPUB Reader. Use the reader's
  public API in lnlib's integration for lnlib-specific behavior. Keep the
  shared files unchanged. EPUB Reader owns fixes to shared reader code and
  syncs them to all consumers.
