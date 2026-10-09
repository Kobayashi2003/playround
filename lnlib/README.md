# lnlib — 蔵書棚

A local bookshelf and reader for a Japanese light novel / manga collection.
Point it at the folders your books live in; it indexes them, shows them as a
shelf with covers, and reads EPUB, Kindle AZW3, comics, PDF and text in the
browser.

The server is Python standard library only. The interface is React and is
built once.

## Setup

```bash
cd web && pnpm install && pnpm build && cd ..

python -m lnlib config --add-root "D:\Books\Novels"                    # shelves layout
python -m lnlib config --add-root "D:\Books\Calibre" --layout authors  # Calibre layout
python -m lnlib scan
python -m lnlib serve          # http://127.0.0.1:16020
```

`蔵書棚.cmd` starts the server and opens the browser.

## How folders are read

**`shelves`** (default) — folders directly under the root are shelves; below a
shelf, folders are searched to any depth.

```
<root>/<shelf>/[imprint][author][illustrator][YYMMDD] Title.epub
<root>/<shelf>/[author] Folder/Volume.epub
<root>/<shelf>/…/第01巻/*.jpg            a folder of images is one volume
```

**`authors`** — folders directly under the root are authors, as in a Calibre
export (`Author/Title - Author.epub`). The author comes from the folder name.

In both, bracketed tags are credits: three is imprint / author / illustrator,
two is imprint / author, one is the author, six digits is the release date.
Folders starting with `_` are skipped.

## Formats

| format | opened with |
|---|---|
| `.epub` `.azw3` | the built-in reader (vertical writing, search, bookmarks) |
| `.mobi` | the same, if it carries a KF8 part; otherwise 外部 |
| `.cbz` `.zip`, image folders | the built-in comic reader |
| `.txt` | the built-in text reader |
| `.pdf` | the browser's PDF viewer |
| `.cbr` `.rar` `.7z` `.tar` | your desktop app (外部) |

DRM-protected books are not opened here, in any format.

## Everyday use

```bash
python -m lnlib scan          # after adding or moving books
python -m lnlib covers        # optional: extract every cover in advance
python -m lnlib config        # list the roots
python -m lnlib config --remove-root "D:\Books\Old"
python -m lnlib --help        # everything else
```

- `scan` never deletes anything. A book whose file has gone is kept and marked;
  it is removed only when you open it and the file really is missing.
- Removing a root takes its books off the shelf. The files are untouched, and
  adding the root back restores the books and their reading progress.
- Deleting a book from the shelf asks whether to keep the file or move it to a
  `_trash` folder on the same drive. Everything in the trash can be restored
  (ゴミ箱 in the sidebar, or `python -m lnlib trash` / `restore`).
- 選択 on a shelf turns it into a picker: click to tick, Shift-click for a run,
  すべて選択 for everything the current filter matches (the server resolves
  that, so it really is all of them). The ticked books can be taken off the
  shelf or have their reading progress cleared in one go; the trash takes the
  same treatment. From the command line, `delete` and `restore` accept several
  ids at once.

## Where things are kept

`config.json` holds your roots (see `config.example.json`). `data/` holds the
index, the cover cache and reading progress — back up `data/library.db` if you
care about your progress. Both are git-ignored.

`serve` also takes `--host`, `--port` and `--base-path /prefix` for running
behind a reverse proxy. `pnpm dev` in `web/` gives a hot-reloading interface on
http://127.0.0.1:16021 that talks to a running `serve`.
