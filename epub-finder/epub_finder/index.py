"""Incremental SQLite index and literal, case-insensitive search."""

from __future__ import annotations

from dataclasses import dataclass
from contextlib import contextmanager
from pathlib import Path
import re
import sqlite3
from typing import Callable, Iterator

from .epub import read_epub


@dataclass(frozen=True)
class Hit:
    book_id: int
    path: str
    book: str
    author: str
    chapter_number: int
    chapter: str
    href: str
    paragraph_number: int
    offset: int
    excerpt: str
    match_start: int
    match_end: int


class SearchIndex:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db_path = db_path
        with self._connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS books (
                    id INTEGER PRIMARY KEY,
                    root TEXT NOT NULL,
                    path TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    author TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    mtime_ns INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS paragraphs (
                    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                    chapter_number INTEGER NOT NULL,
                    chapter TEXT NOT NULL,
                    href TEXT NOT NULL,
                    paragraph_number INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    folded TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS books_root ON books(root);
                CREATE INDEX IF NOT EXISTS paragraphs_book_chapter ON paragraphs(book_id, chapter_number);
            """)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.db_path)
        db.execute("PRAGMA foreign_keys = ON")
        try:
            yield db
        finally:
            db.close()

    def scan(self, root: Path, progress: Callable[[int, int, str], None] | None = None) -> tuple[int, list[str]]:
        root = root.resolve()
        files = sorted((p for p in root.rglob("*") if p.is_file() and p.suffix.lower() == ".epub"), key=lambda p: str(p).casefold())
        seen = {str(p) for p in files}
        errors: list[str] = []
        updated = 0
        with self._connect() as db:
            existing = {row[0]: (row[1], row[2]) for row in db.execute(
                "SELECT path, size, mtime_ns FROM books WHERE root = ?", (str(root),)
            )}
            for i, path in enumerate(files, 1):
                path_str = str(path)
                if progress:
                    progress(i, len(files), path.name)
                try:
                    stat = path.stat()
                    if existing.get(path_str) == (stat.st_size, stat.st_mtime_ns):
                        continue
                    book = read_epub(path)
                    with db:
                        db.execute("DELETE FROM books WHERE path = ?", (path_str,))
                        cursor = db.execute(
                            "INSERT INTO books(root, path, title, author, size, mtime_ns) VALUES (?, ?, ?, ?, ?, ?)",
                            (str(root), path_str, book.title, book.author, stat.st_size, stat.st_mtime_ns),
                        )
                        book_id = cursor.lastrowid
                        db.executemany(
                            "INSERT INTO paragraphs VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (
                                (book_id, chapter.number, chapter.title, chapter.href, j, text, text.casefold())
                                for chapter in book.chapters
                                for j, text in enumerate(chapter.paragraphs, 1)
                            ),
                        )
                    updated += 1
                except (OSError, ValueError, sqlite3.Error) as exc:
                    with db:
                        db.execute("DELETE FROM books WHERE path = ?", (path_str,))
                    errors.append(f"{path.name}: {exc}")
            missing = set(existing) - seen
            with db:
                db.executemany("DELETE FROM books WHERE path = ?", ((p,) for p in missing))
        return updated, errors

    def count_books(self, root: Path) -> int:
        with self._connect() as db:
            return db.execute("SELECT count(*) FROM books WHERE root = ?", (str(root.resolve()),)).fetchone()[0]

    def search(self, root: Path, query: str, limit: int = 500) -> tuple[list[Hit], bool]:
        query = query.strip()
        if not query:
            return [], False
        pattern = re.compile(re.escape(query), re.IGNORECASE)
        hits: list[Hit] = []
        with self._connect() as db:
            rows = db.execute("""
                SELECT b.id, b.path, b.title, b.author, p.chapter_number, p.chapter,
                       p.href, p.paragraph_number, p.text
                FROM paragraphs p JOIN books b ON b.id = p.book_id
                WHERE b.root = ? AND instr(p.folded, ?) > 0
                ORDER BY b.title COLLATE NOCASE, p.chapter_number, p.paragraph_number
            """, (str(root.resolve()), query.casefold()))
            for row in rows:
                text = row[8]
                for match in pattern.finditer(text):
                    start, end = match.span()
                    left, right = max(0, start - 65), min(len(text), end + 85)
                    excerpt = ("…" if left else "") + text[left:right] + ("…" if right < len(text) else "")
                    hits.append(Hit(*row[:8], start + 1, excerpt, start - left + (1 if left else 0), end - left + (1 if left else 0)))
                    if len(hits) > limit:
                        return hits[:limit], True
        return hits, False

    def chapter_text(self, book_id: int, chapter_number: int) -> list[str]:
        with self._connect() as db:
            return [row[0] for row in db.execute(
                "SELECT text FROM paragraphs WHERE book_id = ? AND chapter_number = ? ORDER BY paragraph_number",
                (book_id, chapter_number),
            )]
