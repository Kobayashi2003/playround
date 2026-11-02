# EPUB Finder

A desktop app that searches the text of every EPUB under a folder and previews the matching
chapter with the hit highlighted.

## Run

Requires [uv](https://docs.astral.sh/uv/); standard library only (uv's Python includes Tkinter).

```bash
uv run main.pyw    # runs without a console window
```

Choosing a folder indexes it; **Update Index** picks up added, changed or deleted books. Search
is a case-insensitive literal match (characters, Chinese phrases, short English words); the
first 500 hits are shown. Only visible XHTML/HTML text in spine order is searched — not images,
not DRM-protected books, and not books with a content file over 25 MB.

Settings live in `data/` and the search index in `cache/` (safe to delete; the next scan
rebuilds it). `EPUB_FINDER_DATA_DIR` and `EPUB_FINDER_CACHE_DIR` move them; a relative path is
relative to this folder. Nothing is uploaded.
