"""SQLite storage.

Two kinds of data live here and they are treated very differently:

* Derived data (series/items/covers) is a *cache* of what is on disk. It can be
  thrown away and rebuilt by `scan` at any time. Nothing may be stored here
  that cannot be recovered from the filesystem.

* Durable data (reading progress) belongs to the reader and must survive a
  rescan, so it is keyed by the book's path rather than by its row id.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from typing import Any

from . import config

SCHEMA = """
PRAGMA journal_mode=WAL;

-- ---------- derived cache (safe to drop and rebuild) ----------
CREATE TABLE IF NOT EXISTS series (
    id           INTEGER PRIMARY KEY,
    root_label   TEXT NOT NULL,
    root_kind    TEXT NOT NULL,
    shelf        TEXT NOT NULL,
    author       TEXT,
    title        TEXT NOT NULL,
    path         TEXT NOT NULL,
    is_flat      INTEGER NOT NULL DEFAULT 0,
    n_items      INTEGER NOT NULL DEFAULT 0,
    n_missing    INTEGER NOT NULL DEFAULT 0,
    n_undated    INTEGER NOT NULL DEFAULT 0,
    first_date   TEXT,
    last_date    TEXT,
    series_key   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_series_shelf ON series(root_label, shelf);
CREATE INDEX IF NOT EXISTS ix_series_key   ON series(series_key);

CREATE TABLE IF NOT EXISTS items (
    id           INTEGER PRIMARY KEY,
    series_id    INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    path         TEXT NOT NULL UNIQUE,
    filename     TEXT NOT NULL,
    title        TEXT NOT NULL,
    ext          TEXT NOT NULL,
    date         TEXT,
    volume       TEXT,
    is_missing   INTEGER NOT NULL DEFAULT 0,
    is_extra     INTEGER NOT NULL DEFAULT 0,
    is_dir       INTEGER NOT NULL DEFAULT 0,
    size         INTEGER NOT NULL DEFAULT 0,
    mtime        REAL NOT NULL DEFAULT 0,
    sort_date    TEXT,
    sort_vol     REAL
);
CREATE INDEX IF NOT EXISTS ix_items_series ON items(series_id);
CREATE INDEX IF NOT EXISTS ix_items_missing ON items(is_missing);

CREATE TABLE IF NOT EXISTS covers (
    item_id      INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    cache_name   TEXT,
    mime         TEXT,
    source       TEXT,          -- epub-opf | zip-first | folder-first | pdf-jpeg | mobi-jpeg | none
    state        TEXT NOT NULL, -- ok | none | error
    detail       TEXT,
    updated_at   REAL NOT NULL
);

-- ---------- durable, survives rescans ----------
-- Where the reader left off. Keyed by path so a rescan does not lose it; a
-- book renamed on disk simply starts again from the beginning.
CREATE TABLE IF NOT EXISTS reading (
    path         TEXT PRIMARY KEY,
    locator      TEXT,           -- epub: spine href | images: page index | pdf: page
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


def connect() -> sqlite3.Connection:
    config.ensure_dirs()
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)


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


def series_key(author: str | None, title: str) -> str:
    """Stable identity for a series, independent of its current folder name."""
    from .naming import norm
    return f"{norm(author or '')}|{norm(title)}"


def now() -> float:
    return time.time()
