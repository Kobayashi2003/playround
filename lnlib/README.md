# lnlib — 蔵書棚

A local bookshelf and reader for a Japanese light novel / manga / artbook
collection. Browse what you own, see what you are missing, and read a volume
in the browser.

Standard library only. No dependencies, no build step, no package manager.

```
python -m lnlib scan      # index the shelves
python -m lnlib covers    # extract cover images
python -m lnlib serve     # open the UI at http://127.0.0.1:8770
```

`serve` also takes `--host`, `--port` and `--base-path /prefix`; the same three
can be set in `config.json` as `host`, `port` and `base_path`. `base_path` is for
running behind a shared edge, where one public port fronts several apps and the
origin root belongs to none of them: the prefix is stripped at the door so every
route keeps its own shape, and the page resolves its own URLs against the
directory it was served from, so nothing else has to be told where it is mounted.

## What it is for

- **What do I have?** Browse by shelf, or search across everything. Rearrange
  the shelves on disk and `scan` picks the new arrangement up on its own.
- **What am I missing?** Volumes you do not own are `.txt` placeholders named
  exactly like the books; the 欠落巻 view lists every one of them.
- **Read it.** Open any volume in the built-in reader and it remembers where
  you stopped.

## Layout it understands

Nothing about the layout is configured. Each root is read as it is found, and
the two shapes below can sit side by side in the same root:

```
<root>/<shelf>/[imprint][author][illustrator][YYMMDD] Title.epub   a flat shelf
<root>/<shelf>/[author] Series Title/[YYMMDD] Volume.epub          a series folder
<root>/<shelf>/[author] Series/第01巻/*.jpg                        scanned pages
```

A folder whose name starts with `[` belongs to whoever made the book, so it is
content — a series, or a volume of page scans. Any other folder directly under
a root is a shelf (`1. 連載中`, `3. 完結` …). A folder starting with `_` is
ignored, which is how a staging area stays out of the library. Add a shelf,
rename one, or empty one, and the next scan simply reflects it.

The bracketed tags are read by how many there are: three or more means
imprint / author / illustrator, two means imprint / author, one is the author.
Six digits anywhere in them is the original print release date.

**Novels are a flat pile of files**, so the series a volume belongs to is
recovered from its title — the trailing number, a `~subtitle~`, or a number
sitting between the name and a per-volume subtitle (`緋弾のアリア IX 蒼き閃光`)
are peeled away and what remains is the series. That is what puts
`ひきこまり吸血姫の悶々12` next to the `.txt` standing in for volume 11.

`[YYMMDD]` is the original print release date. A `.txt` always means "not owned"
— this collection has no text-format novels.

Roots are configured in `config.json`; only the folders themselves are.

```bash
python -m lnlib config                              # show roots
python -m lnlib config --add-root "E:\..." --label "…" --kind novel
```

## The reader

Open a volume from its series page (読む / 続き), or pick up where you left off
from 読書中 in the sidebar.

| format | how it is read |
|---|---|
| `.epub` | the spine, one section at a time, in an iframe |
| `.cbz` | page images in filename order |
| image folder | page images in filename order |
| `.pdf` | handed to the built-in PDF viewer of the browser |
| `.azw3` `.mobi` `.cbr` | no renderer — 外部 opens it in the desktop app |

The inside of a book is served as a virtual directory (`/book/<id>/f/…`), so an
epub's own CSS, fonts and images resolve without rewriting a single link. That
is also why **vertical writing and right-to-left page progression just work** —
they are the book's own stylesheet, rendered by the browser. The reader reads
`page-progression-direction` and flips the arrow keys and the page buttons to
match; in a right-to-left book, ◀ and the left half of a manga page move
*forward*.

Controls: ← → PageUp PageDown Space to turn, `+` `-` for text size, Esc to
leave. 目次 opens the table of contents (EPUB3 nav, else the NCX), 紙 cycles the
reading background (紙 / 白 / セピア / 暗), A− A＋ scale the text.

Position is saved as you read — the spine section plus how far into it, or the
page number for manga — and restored the next time you open the volume. It is
keyed by the file's path, so renaming a book on disk starts it over.

```bash
python -m lnlib reading      # everything with saved progress
python -m lnlib book 1234    # what the reader sees inside one volume
```

## Covers

Extracted byte-for-byte and cached under `data/covers/` — nothing is decoded or
re-encoded, which is why no imaging library is needed.

| format | how |
|---|---|
| `.epub` | OPF `<meta name="cover">`, else EPUB3 `cover-image`, else first image |
| `.cbz` | first image by filename |
| image folder | first image by filename |
| `.pdf` | first large embedded JPEG |
| `.azw3` / `.mobi` | first large embedded JPEG |
| `.txt` | none — it is a placeholder, not a book |

`python -m lnlib covers --redo` rebuilds them all. Without `--redo` an image
already in the cache is reused, so re-running `scan` after the shelves change
costs a few seconds rather than another walk through several thousand epubs.

## Why the shelf stays smooth

The covers are byte-for-byte copies of what was inside the books: on this
collection they average ~1 MB and 2.4 megapixels, and the largest is 67 MB.
Drawn at 132 px that costs roughly 10 MB of decoded bitmap per tile, so a
shelf of a thousand series used to take hundreds of megabytes and stall every
few rows. Two things fix it, and neither adds a dependency:

- **The grid is virtual.** Only the rows crossing the viewport exist as
  elements — a few dozen — and the card elements are recycled as they scroll.
  The empty space above and below is exact, so the scrollbar still tells the
  truth. Rows of data are fetched a page at a time as you reach them.
- **Thumbnails are made by the browser.** There is no imaging library on the
  Python side, so `web/thumbs.js` fetches each cover once, lets the browser
  decode it straight down to 264 px, re-encodes it as a ~30 KB JPEG and keeps
  it in IndexedDB. After the first look at a tile it costs 30 KB instead of
  1 MB. The cache is stamped with the scan it was built from and is discarded
  automatically after a rescan, because `scan` renumbers items.

Measured on this collection, scrolling the same distance through すべて:

| | DOM cards | cover traffic | stalls > 50 ms | worst frame |
|---|---|---|---|---|
| before | 480 | 285 MB | 20 (1.8 s total) | 235 ms |
| after, first visit | ~90 | 28 MB | 0 | 17 ms |
| after, cached | ~90 | 0 MB | 0 | 9 ms |

If IndexedDB or `createImageBitmap` is unavailable the grid quietly falls back
to the full-size covers; it is slower, exactly as it was before, but correct.

## Files

```
lnlib/          config, naming rules, scanner, cover extraction,
                the reader, queries, HTTP server, CLI
web/            single-page UI (no framework)
                app.js is the shelf and reader, thumbs.js the cover cache
data/           SQLite index + cover cache — rebuilt by `scan`
config.json     roots, host, port
```

Everything in `data/` except reading progress is derived from disk and can be
thrown away; `scan` and `covers` rebuild it. Reading positions live in the same
database, so back up `data/library.db` if you care about them.
