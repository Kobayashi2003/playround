# EPUB Finder

A desktop app that searches the text of every EPUB under a folder and previews the matching
chapter with the hit highlighted.

## Run

Requires Python 3.14 with Tkinter; standard library only.

```bash
pythonw main.pyw    # Windows, without a console window
python main.pyw
```

Choosing a folder indexes it; **Update Index** picks up added, changed or deleted books. Search
is a case-insensitive literal match (characters, Chinese phrases, short English words); the
first 500 hits are shown. Only visible XHTML/HTML text in spine order is searched — not images,
not DRM-protected books, and not books with a content file over 25 MB.

The index and settings live in `%LOCALAPPDATA%\EpubFinder` (the platform's app-data directory
elsewhere). Nothing is uploaded.
