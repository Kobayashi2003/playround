# lnlib — 蔵書棚

A local bookshelf and reader for a Japanese light novel and manga collection: indexes your book
folders, shows them as a shelf with covers, and reads EPUB, AZW3, comics, PDF and text in the
browser.

## Run

Requires Python 3.14 (standard library only) and, to build the interface once, Node.js with pnpm.

```bash
cd web && pnpm install && pnpm build && cd ..

python main.py config --add-root "D:\Books\Novels"                    # shelves layout
python main.py config --add-root "D:\Books\Calibre" --layout authors  # Calibre layout
python main.py scan
python main.py serve          # http://127.0.0.1:16020
```

`python main.py --help` lists the other commands (`covers`, `trash`, `restore`, `delete`, …).
`serve` takes `--host`, `--port` and `--base-path /prefix`. `pnpm dev` in `web/` serves a
hot-reloading interface on port 16021 against a running `serve`.

On Windows, `start.ps1` / `stop.ps1` start and stop the server (`start.ps1 -Build` builds the
interface first); `蔵書棚.cmd` is a double-click shortcut for `start.ps1`.

## How folders are read

**`shelves`** (default): folders under the root are shelves, searched to any depth.

```
<root>/<shelf>/[imprint][author][illustrator][YYMMDD] Title.epub
<root>/<shelf>/[author] Folder/Volume.epub
<root>/<shelf>/…/第01巻/*.jpg            a folder of images is one volume
```

**`authors`**: folders under the root are authors, as in a Calibre export.

Bracketed tags are credits — three: imprint / author / illustrator; two: imprint / author; one:
author; six digits: release date. Folders starting with `_` are skipped.

## Formats

| Format | Opened with |
|---|---|
| `.epub` `.azw3`, `.mobi` with a KF8 part | Built-in reader |
| `.cbz` `.zip`, image folders | Built-in comic reader |
| `.txt` | Built-in text reader |
| `.pdf` | The browser's PDF viewer |
| `.cbr` `.rar` `.7z` `.tar`, other `.mobi` | Your desktop app |

DRM-protected books are not opened.

## Data

`config.json` holds the roots; `data/` holds the index, cover cache and reading progress (back
up `data/library.db`). `scan` never deletes; removing a root keeps its files, and re-adding it
restores the books and their progress. Deleted books go to a `_trash` folder on the same drive
and can be restored.
