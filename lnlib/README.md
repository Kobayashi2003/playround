# lnlib — 蔵書棚

A local bookshelf and reader for a Japanese light novel / manga / artbook
collection.

The index and server are Python standard library only. The interface is React
and has to be built once.

```
cd web && npm install && npm run build   # the front end, once
python -m lnlib scan                     # index the shelves
python -m lnlib covers                   # extract cover images
python -m lnlib serve                    # http://127.0.0.1:8770
```

`npm run dev` in `web/` serves the interface with hot reloading and proxies
`/api`, `/cover` and `/book` through to `serve`.

`serve` takes `--host`, `--port` and `--base-path /prefix` (also settable in
`config.json`); the prefix is for running behind a shared edge that fronts
several apps on one port. `python -m lnlib --help` lists the rest.

## One row is one book

There is no series in this index. A volume is a file; a title is read as it was
written; a volume number is only ever taken from the name of the file it sits
in. Whatever grouping the collection has is the grouping it has on disk, which
is why a book lists the other files in its folder and claims nothing more.

Opening a book is a dialog over the shelf, not a page of its own — the grid
keeps its rows and its scroll position behind it. It is still a route, so the
back button closes it and a link opens straight onto it.

## Layout it understands

Nothing about the layout is configured; each root is read as it is found.

```
<root>/<shelf>/[imprint][author][illustrator][YYMMDD] Title.epub   loose on a shelf
<root>/<shelf>/[author] Folder Title/[YYMMDD] Volume.epub          inside a folder
<root>/<shelf>/[author] Something/第01巻/*.jpg                     scanned pages
```

A folder starting with `[` is content — a place books sit in, or a volume of
page scans. Any other folder under a root is a shelf. A folder starting with `_`
is ignored, which is how a staging area and the trash stay out of the library.

Bracketed tags are read by how many there are: three or more is
imprint / author / illustrator, two is imprint / author, one is the author. Six
digits anywhere in them is the release date. A folder lends its credits to the
files inside it.

Roots live in `config.json`:

```bash
python -m lnlib config --add-root "E:\..." --label "…" --kind novel
```

## Formats

Every recognised extension is a format the shelf counts and filters by; a `.txt`
is a text file, not a stand-in for something missing.

| format | how it is read |
|---|---|
| `.epub` | the bundled reader: pagination, vertical writing, search, marks |
| `.txt` | text, decoded server-side, horizontal or vertical |
| `.cbz`, image folder | page images in filename order |
| `.pdf` | the browser's own viewer |
| `.azw3` `.mobi` `.cbr` | no renderer — 外部 opens the desktop app |

## The index remembers

It is a record of what has been seen, not a mirror of what is on disk this
minute. That is the whole of how books leave it:

- **`scan` adds and updates; it never deletes.** A book it did not find is
  marked absent and keeps everything else. A root it could not open is skipped
  entirely, so an unplugged drive marks nothing.
- **Opening a book that is really gone retires it** — the one moment the absence
  has been tested rather than inferred. It goes to the trash, not to nothing.
- **Deleting asks what to do with the file.** 記録だけ削除 leaves it on disk;
  ファイルもゴミ箱へ moves it too.
- **The trash is real.** A file moves to a `_trash` folder inside its own root —
  already ignored by the scanner, and on the same drive, so trashing a 14 GB
  folder of scans is a rename rather than a copy. Restoring returns file and row
  with the id it had. Only 「完全に削除」 destroys anything, and never a file
  this shelf did not move.

```bash
python -m lnlib delete 1234 --file --yes  # off the shelf, file to _trash
python -m lnlib trash                     # what is in there
python -m lnlib restore 7                 # put one back
python -m lnlib trash --empty --yes       # the only destructive command
```

Reading progress is keyed by path, so it survives a rescan and comes back with a
restored book.

## The reader

`epub-reader-engine`, vendored under `web/src/epub-reader/` from
component-atlas. It opens the container, parses the package and paginates in the
browser, so **vertical writing and right-to-left progression are the book's own**
— and there is exactly one EPUB implementation here. Python hands it the file
and nothing else. Those files are upstream's and are not edited; re-copy them
wholesale when the engine moves on.

Position is kept twice: the reader's own session (locator, preferences, marks)
in `localStorage`, because its storage port is synchronous; and, throttled, on
the server, which is what 読書中 and the progress badges are built from. Opening
a book takes whichever was written last.

## Why the shelf stays smooth

Covers are byte-for-byte copies out of the books — ~1 MB and 2.4 megapixels on
average, the largest 67 MB. Four thousand of those would be hundreds of
megabytes of decoded bitmap. Four things prevent it:

- **The grid is virtual** — only rows crossing the viewport exist as elements,
  with exact empty space above and below so the scrollbar stays honest.
- **Rows arrive a page at a time**, only for the range about to be drawn, and
  what has been fetched is kept, so leaving a book lands back on the same rows.
- **Thumbnails are made by the browser** — each cover is fetched once, decoded
  straight down to 264 px, re-encoded to ~30 KB and kept in IndexedDB.
- **Nothing flashes** — spinners are held back ~180 ms, search waits for the
  typing to settle, scrolling is handled once per frame.

The reader is a separate bundle, not downloaded until a book is opened.

## Files

```
lnlib/            scanner, cover extraction, HTTP server, CLI
  queries.py      everything that reads the index
  library.py      everything that changes it: forget, discard, restore
web/src/
  lib/            api client, page store, thumbnail cache, timing hooks
  views/          shelf, reading, formats, folders, trash, reader
  components/     grid, covers, book dialog, select
  reader/         epub / images / text, each its own lazy chunk
  epub-reader/    vendored engine — upstream files, not edited here
web/dist/         built bundle, which is what `serve` serves
data/             SQLite index + cover cache
```

`data/covers/` is pure cache. `data/library.db` is not: it holds reading
progress *and* the record of books whose files are no longer where they were.
Back it up if you care about either.
