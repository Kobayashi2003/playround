"""SQLite storage.

The index is a *record of what has been seen*, not a mirror of what is on disk
this minute. `scan` adds what it finds and updates what has changed, and a book
it no longer finds is marked `present = 0` rather than deleted: a drive that is
not plugged in, a folder being reorganised, or a rename in progress must not
quietly cost the shelf everything it knew.

So a row leaves the index only when someone means it to:

* opening a book and finding the file genuinely gone retires its row, because
  that is the one moment the absence has actually been confirmed;
* deleting a book from the shelf moves its row to `trash`, and optionally the
  file with it, and both can be put back.

Covers are still pure cache -- keyed by book id, rebuilt from the file on
demand. Reading progress is keyed by path so a rescan cannot lose it.

One row is one book. There is no series table: the shelf shows volumes, and
whatever grouping the collection has is the grouping it has on disk. Every file
the scanner recognises is a book of some `format`, `.txt` included -- the index
records what a thing is, not what it is instead of.
"""
from __future__ import annotations

import contextlib
import json
import sqlite3
import time
from collections.abc import Iterator
from typing import Any

from . import config
from .naming import natural

SCHEMA = """
PRAGMA journal_mode=WAL;

-- ---------- derived cache (safe to drop and rebuild) ----------
CREATE TABLE IF NOT EXISTS books (
    -- AUTOINCREMENT, so an id is never handed out twice. Anything keyed by an
    -- id -- the browser's thumbnail cache, a trash entry waiting to be put back
    -- -- would otherwise find a different book behind it once the highest ids
    -- had been deleted and the next scan reused them.
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    root_label   TEXT NOT NULL,
    root_kind    TEXT NOT NULL,
    shelf        TEXT NOT NULL,
    folder       TEXT NOT NULL DEFAULT '',  -- containing folder, '' when loose
    path         TEXT NOT NULL UNIQUE,
    filename     TEXT NOT NULL,
    title        TEXT NOT NULL,
    author       TEXT,
    imprint      TEXT,
    illustrator  TEXT,
    ext          TEXT NOT NULL,
    -- The extension without its dot, or `images` for a folder of page scans.
    -- Kept beside `ext` because it is what the shelf counts and filters by.
    format       TEXT NOT NULL DEFAULT '',
    date         TEXT,
    volume       TEXT,
    is_extra     INTEGER NOT NULL DEFAULT 0,
    is_dir       INTEGER NOT NULL DEFAULT 0,
    size         INTEGER NOT NULL DEFAULT 0,
    mtime        REAL NOT NULL DEFAULT 0,
    sort_date    TEXT,
    sort_vol     REAL,
    -- Whether the last scan still found this file. A 0 here is a question, not
    -- a verdict: the row keeps everything it knew until someone confirms.
    present      INTEGER NOT NULL DEFAULT 1,
    first_seen   REAL NOT NULL DEFAULT 0,
    last_seen    REAL NOT NULL DEFAULT 0,
    -- Folded once here rather than in every query: the search box matches the
    -- same way `naming.norm` does, which SQL's own lower()/replace() cannot.
    norm_title   TEXT NOT NULL DEFAULT '',
    norm_author  TEXT NOT NULL DEFAULT '',
    -- The title again, with every run of digits padded, so that volume 2
    -- comes before volume 10. Ordering reads this; searching reads
    -- `norm_title`, which still has the number as it was written.
    nat_title    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_books_shelf   ON books(root_label, shelf);
CREATE INDEX IF NOT EXISTS ix_books_format  ON books(format);
CREATE INDEX IF NOT EXISTS ix_books_present ON books(present);
CREATE INDEX IF NOT EXISTS ix_books_sort    ON books(sort_date, sort_vol);
CREATE INDEX IF NOT EXISTS ix_books_author  ON books(norm_author);

CREATE TABLE IF NOT EXISTS covers (
    book_id      INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    cache_name   TEXT,
    mime         TEXT,
    source       TEXT,          -- epub-opf | zip-first | folder-first | pdf-jpeg | mobi-jpeg | none
    state        TEXT NOT NULL, -- ok | none | error
    detail       TEXT,
    updated_at   REAL NOT NULL
);

-- Books taken off the shelf. The whole row is kept as JSON so putting one back
-- restores exactly what was there, including the id it had. `file_state` says
-- what happened to the file itself: `kept` means it is still where it was and
-- only the record was dropped; `trashed` means it was moved to `trash_path`,
-- which is inside the same root and so was a rename rather than a copy.
CREATE TABLE IF NOT EXISTS trash (
    -- AUTOINCREMENT for the same reason the books table has it: a restore or
    -- a purge is asked for by id, and a screen left open while the trash was
    -- emptied would otherwise name an entry that is now somebody else.
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    path         TEXT NOT NULL,
    title        TEXT NOT NULL,
    author       TEXT,
    format       TEXT NOT NULL DEFAULT '',
    size         INTEGER NOT NULL DEFAULT 0,
    row          TEXT NOT NULL,   -- the whole books row, JSON
    file_state   TEXT NOT NULL,   -- kept | trashed | vanished
    trash_path   TEXT,
    reason       TEXT,            -- deleted | vanished
    trashed_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_trash_at ON trash(trashed_at DESC);

-- ---------- durable, survives rescans ----------
-- Where the reader left off. Keyed by path so a rescan does not lose it; a
-- book renamed on disk simply starts again from the beginning.
CREATE TABLE IF NOT EXISTS reading (
    path         TEXT PRIMARY KEY,
    locator      TEXT,           -- epub: JSON locator | images: page index | pdf: page
    position     REAL NOT NULL DEFAULT 0,   -- 0..1 within the current section
    percent      REAL NOT NULL DEFAULT 0,   -- 0..1 through the whole book
    finished     INTEGER NOT NULL DEFAULT 0,
    updated_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reading_at ON reading(updated_at DESC);

CREATE TABLE IF NOT EXISTS meta (
    key          TEXT PRIMARY KEY,
    value        TEXT
);
"""

# Tables whose ids are promised never to come round again, because something
# outside the database is holding them: the browser's thumbnail cache keys on a
# book id, and a trash entry is restored or purged by its own.
AUTOINCREMENT_TABLES = ("books", "trash")

# Tables the series-shaped index used. `scan` no longer writes them and every
# query has moved to `books`, so an old database is brought forward by dropping
# them; reading progress is keyed by path and is not touched.
LEGACY_TABLES = ("items", "series")


@contextlib.contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """A connection for the length of one `with`: committed, then closed.

    `sqlite3`'s own context manager ends the transaction and leaves the
    connection open, so every request and every command was handing its file
    handle back to the garbage collector rather than closing it. The
    transaction behaves exactly as before -- commit on the way out, rollback if
    the block raised -- and the connection is closed either way.

    Rows outlive it: `fetchone` and `fetchall` return tuples, not cursors into
    a database that is about to be let go.
    """
    config.ensure_dirs()
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def init() -> None:
    with connect() as conn:
        _migrate(conn)
        _never_reuse_ids(conn)
        conn.executescript(SCHEMA)
        _stamp_epoch(conn)


def _never_reuse_ids(conn: sqlite3.Connection) -> None:
    """Rebuild any table that could hand an id out twice, keeping every row.

    Without AUTOINCREMENT SQLite gives a new row the highest id plus one, so
    deleting the newest rows -- a whole root, or everything in the trash -- and
    inserting again reissues those ids to different things. SQLite cannot add
    AUTOINCREMENT in place, so the table is copied into one that has it. Every
    row keeps the id it had, so covers and thumbnails already made for a book
    stay attached to that book, and an entry in the trash stays itself.

    The indexes go with the dropped table and are written again by SCHEMA,
    which `init` runs immediately after this.
    """
    for table in AUTOINCREMENT_TABLES:
        row = conn.execute("SELECT sql FROM sqlite_master "
                           "WHERE type='table' AND name=?", (table,)).fetchone()
        if not row or "AUTOINCREMENT" in (row["sql"] or "").upper():
            continue

        head = f"CREATE TABLE IF NOT EXISTS {table} ("
        start = SCHEMA.index(head)
        end = SCHEMA.index(");", start) + 2
        ddl = SCHEMA[start:end].replace(head, f"CREATE TABLE {table}_new (", 1)
        columns = [c["name"] for c in conn.execute(f"PRAGMA table_info({table})")]
        listed = ",".join(columns)

        conn.commit()
        # Off for the copy: dropping the books table would otherwise cascade
        # into the covers that refer to it, and every extracted cover would be
        # forgotten.
        conn.execute("PRAGMA foreign_keys=OFF")
        try:
            conn.execute(ddl)
            conn.execute(f"INSERT INTO {table}_new({listed}) "
                         f"SELECT {listed} FROM {table}")
            conn.execute(f"DROP TABLE {table}")
            conn.execute(f"ALTER TABLE {table}_new RENAME TO {table}")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.execute("PRAGMA foreign_keys=ON")


def _stamp_epoch(conn: sqlite3.Connection) -> None:
    """Mark which incarnation of the books table this is.

    Book ids used to be reassigned by every scan, so anything keyed by one --
    the browser's thumbnail cache, above all -- had to be discarded whenever
    the shelf was rescanned. A scan now updates rows in place and ids survive
    it, so the only thing that can invalidate them is the table being built
    again from nothing. This is stamped exactly then, and it is what the front
    end compares against instead of the time of the last scan.
    """
    if get_meta(conn, "index_epoch") is None:
        set_meta(conn, "index_epoch", time.time())


def _migrate(conn: sqlite3.Connection) -> None:
    """Bring a database written by the series-shaped index forward.

    The covers table used to be keyed by `item_id`, and item ids came from a
    table that no longer exists, so there is nothing in it worth keeping -- the
    cached image files themselves are found again by path hash on the next
    extraction. Reading progress is keyed by path and survives untouched.
    """
    have = {r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    # `is_missing` is gone: a .txt is a text file rather than the absence of an
    # epub, so the column it was recorded in has no meaning to carry forward.
    # The table is derived from disk and `scan` rebuilds it in seconds.
    if "books" in have:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(books)")}
        if "format" not in cols or "is_missing" in cols or "present" not in cols:
            conn.execute("DROP TABLE books")
            have.discard("books")
            if "covers" in have:
                conn.execute("DROP TABLE covers")
                have.discard("covers")
            # Ids start again from 1, so everything keyed by one is stale.
            # Clearing the stamp is what tells the browser to drop its cache.
            conn.execute("DELETE FROM meta WHERE key='index_epoch'")
        elif "nat_title" not in cols:
            # Purely additive, and derived from the title already in the row,
            # so it is filled in here rather than waiting for a rescan: the
            # shelf would otherwise be ordered by an empty key until one ran.
            conn.execute("ALTER TABLE books "
                         "ADD COLUMN nat_title TEXT NOT NULL DEFAULT ''")
            rows = conn.execute("SELECT id, title FROM books").fetchall()
            conn.executemany("UPDATE books SET nat_title=? WHERE id=?",
                             [(natural(r["title"]), r["id"]) for r in rows])
    if "covers" in have:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(covers)")}
        if "book_id" not in cols:
            conn.execute("DROP TABLE covers")
    for name in LEGACY_TABLES:
        if name in have:
            conn.execute(f"DROP TABLE IF EXISTS {name}")


def set_meta(conn: sqlite3.Connection, key: str, value: Any) -> None:
    conn.execute(
        "INSERT INTO meta(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, json.dumps(value, ensure_ascii=False)),
    )


def get_meta(conn: sqlite3.Connection, key: str, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    if not row:
        return default
    try:
        return json.loads(row["value"])
    except (TypeError, ValueError):
        return default


def now() -> float:
    return time.time()
