# EPUB Finder

A local desktop application for searching EPUB files in a selected folder and its subfolders. Results show the book, chapter, paragraph, character position, and surrounding text. Select a result to preview the chapter with the match highlighted.

## Run

Requires Python 3.10 or newer with Tkinter. No third-party Python packages are needed.

- Windows: double-click `main.pyw`, or run `pythonw main.pyw` from this directory.
- Other systems: run `python main.pyw` from this directory.

Selecting a folder starts a scan. Use **Update Index** to synchronize added, changed, or deleted EPUB files later. The application remembers the last selected folder and checks it again at startup.

Use the theme button in the upper-right corner to switch between light and dark themes. The selection is saved for the next launch. Drag the divider between results and the chapter preview to resize either area.

Search matches consecutive text without regard to case. It supports single characters, Chinese phrases, and short English words. Each occurrence is a separate result; the first 500 results are shown. Character positions are one-based within a paragraph. Chapter names come from the first heading in each chapter when available, or from the EPUB's internal filename.

The index and settings are stored in the user's local `EpubFinder` application data directory (`%LOCALAPPDATA%\EpubFinder` on Windows). Books and search terms are never uploaded.

## Supported content

The application follows the EPUB OPF spine reading order and searches visible text in XHTML and HTML content files. It cannot search text in images or DRM-protected content. An EPUB is skipped with an error message if one of its internal content files exceeds 25 MB.
