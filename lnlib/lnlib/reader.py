"""Serving a book to the browser, standard library only.

Three shapes of book are readable, and the front end treats each differently:

  epub          handed over whole. The browser-side reader opens the container,
                parses the package and paginates it, so there is exactly one
                EPUB implementation in this project and it is not this file.
  cbz / folder  an ordered list of images, shown one page at a time.
  pdf           handed to the built-in PDF viewer of the browser as-is.
  txt           decoded here and sent as text, because guessing the encoding
                of a Japanese text file is not something a browser will do.

Anything else (.azw3, .mobi, .cbr) has no in-browser renderer here; the UI
offers to open it in the desktop application instead.

The inside of a zip is still served file by file for the image formats, and for
anything that wants to resolve a link into a book without unpacking it.
"""
from __future__ import annotations

import os
import posixpath
import urllib.parse
import zipfile

from . import db, library
from .config import IMAGE_EXT

TEXT_MIME = {
    ".xhtml": "application/xhtml+xml", ".html": "text/html", ".htm": "text/html",
    ".css": "text/css", ".js": "text/javascript", ".xml": "application/xml",
    ".ncx": "application/x-dtbncx+xml", ".opf": "application/oebps-package+xml",
    ".txt": "text/plain",
}
BINARY_MIME = {
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
    ".otf": "font/otf", ".ttf": "font/ttf", ".woff": "font/woff",
    ".woff2": "font/woff2", ".pdf": "application/pdf",
    ".epub": "application/epub+zip",
}
READABLE_ZIP = {".epub", ".cbz"}


def mime_for(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    if ext in TEXT_MIME:
        return TEXT_MIME[ext] + "; charset=utf-8"
    return BINARY_MIME.get(ext, "application/octet-stream")


# ------------------------------------------------------------------- images
def _cbz_pages(path: str) -> list[str]:
    with zipfile.ZipFile(path) as z:
        return sorted(
            (n for n in z.namelist()
             if os.path.splitext(n)[1].lower() in IMAGE_EXT
             and not n.endswith("/") and "__MACOSX" not in n),
            key=lambda n: (len(posixpath.dirname(n)), n.lower()))


def _folder_pages(path: str) -> list[str]:
    try:
        names = os.listdir(path)
    except OSError as e:
        raise ValueError(str(e)) from e
    return sorted((n for n in names
                   if os.path.splitext(n)[1].lower() in IMAGE_EXT),
                  key=str.lower)


# -------------------------------------------------------------------- entry
BOOK_FIELDS = ("id", "title", "filename", "ext", "format", "date", "volume",
               "size", "author", "imprint", "illustrator", "shelf", "folder",
               "root_label", "root_kind", "path")

# Japanese text files come off the shelf in whatever their author saved them
# as, and none of them says so. These are tried in order and the first that
# decodes cleanly wins; UTF-8 is checked first because it usually is.
TEXT_ENCODINGS = ("utf-8-sig", "utf-8", "cp932", "euc-jp", "iso-2022-jp")
TEXT_LIMIT = 4 * 1024 * 1024


def read_text(path: str) -> tuple[str, str]:
    """The contents of a text book, and the encoding it turned out to be in."""
    with open(path, "rb") as fh:
        raw = fh.read(TEXT_LIMIT + 1)
    truncated = len(raw) > TEXT_LIMIT
    raw = raw[:TEXT_LIMIT]
    for encoding in TEXT_ENCODINGS:
        try:
            text = raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
        if truncated:
            text += "\n\n[…]"
        return text, encoding
    # Nothing decoded cleanly, so show it with the damage visible rather than
    # refusing: a few broken characters still read better than an error page.
    return raw.decode("utf-8", "replace"), "utf-8 (replaced)"


def manifest(book_id: int) -> dict:
    """Everything the front end needs in order to open one book.

    For an epub that is deliberately almost nothing: the reader in the browser
    fetches the file itself and reads it. For a pile of images it is the page
    list, because only this side can see inside the zip.
    """
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
    if not row:
        return {"error": "no such book"}
    b = dict(row)
    path, ext = b["path"], (b["ext"] or "").lower()

    out = {"book": {k: b[k] for k in BOOK_FIELDS},
           "progress": progress_for(path)}

    if not os.path.exists(path):
        # Opening a book is the one moment its absence is actually tested
        # rather than inferred, so this is where a record is allowed to go.
        # `retire` refuses if the drive is simply not mounted.
        gone = library.retire(book_id)
        return {**out, "kind": "gone", "retired": bool(gone.get("ok")),
                "detail": gone.get("detail") or (
                    "ファイルが見つからないため、記録を削除しました"
                    if gone.get("ok") else "ファイルが見つかりません")}

    try:
        if b["is_dir"]:
            pages = _folder_pages(path)
        elif ext == ".cbz":
            pages = _cbz_pages(path)
        elif ext == ".epub":
            return {**out, "kind": "epub"}
        elif ext == ".pdf":
            return {**out, "kind": "pdf"}
        elif ext == ".txt":
            text, encoding = read_text(path)
            return {**out, "kind": "text", "text": text, "encoding": encoding}
        else:
            return {**out, "kind": "external",
                    "detail": f"{ext} はブラウザでは開けません"}
    except (zipfile.BadZipFile, ValueError, OSError) as e:
        return {**out, "kind": "error", "detail": f"{type(e).__name__}: {e}"}

    if not pages:
        return {**out, "kind": "error", "detail": "画像が見つかりません"}
    # Scans read right to left; that is what the collection is.
    return {**out, "kind": "images", "pages": pages, "direction": "rtl"}


def resource(book_id: int, rel: str) -> tuple[bytes, str]:
    """One file from inside a book. Raises KeyError / FileNotFoundError."""
    with db.connect() as conn:
        row = conn.execute("SELECT path, ext, is_dir FROM books "
                           "WHERE id=?", (book_id,)).fetchone()
    if not row:
        raise KeyError("no such book")
    path, ext = row["path"], (row["ext"] or "").lower()
    rel = urllib.parse.unquote(rel).lstrip("/")

    if row["is_dir"]:
        safe = posixpath.normpath(rel)
        if safe.startswith("..") or ":" in safe or posixpath.isabs(safe):
            raise KeyError("forbidden")
        full = os.path.join(path, safe.replace("/", os.sep))
        if not os.path.isfile(full):
            raise FileNotFoundError(rel)
        with open(full, "rb") as fh:
            return fh.read(), mime_for(full)

    if ext not in READABLE_ZIP:
        raise KeyError(f"{ext} has no inner files")

    with zipfile.ZipFile(path) as z:
        want = posixpath.normpath(rel)
        try:
            return z.read(want), mime_for(want)
        except KeyError:
            pass
        hit = {n.lower(): n for n in z.namelist()}.get(want.lower())
        if hit is None:
            raise FileNotFoundError(rel)
        return z.read(hit), mime_for(hit)


def whole_file(book_id: int) -> tuple[str, str]:
    """Path and mime of the book itself.

    This is how an epub reaches the reader and how a PDF reaches the browser's
    own viewer, so it is the hot path for opening a book rather than a corner.
    """
    with db.connect() as conn:
        row = conn.execute("SELECT path, ext, is_dir FROM books "
                           "WHERE id=?", (book_id,)).fetchone()
    if not row or row["is_dir"]:
        raise KeyError("not a single-file book")
    if not os.path.isfile(row["path"]):
        raise FileNotFoundError(row["path"])
    return row["path"], mime_for(row["path"])


# ----------------------------------------------------------------- progress
def progress_for(path: str) -> dict | None:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM reading WHERE path=?", (path,)).fetchone()
    return dict(row) if row else None


def save_progress(book_id: int, locator: str | None, position: float,
                  percent: float, finished: bool = False) -> dict:
    """Write where the reader is.

    `locator` is opaque here: the epub reader stores its own JSON locator, the
    image reader a page number. Nothing on this side interprets it, which is
    why the browser reader can change how it addresses a position without the
    index having to know.
    """
    with db.connect() as conn:
        row = conn.execute("SELECT path FROM books WHERE id=?", (book_id,)).fetchone()
        if not row:
            return {"ok": False, "reason": "no such book"}
        conn.execute(
            "INSERT INTO reading(path,locator,position,percent,finished,updated_at) "
            "VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET "
            "locator=excluded.locator, position=excluded.position, "
            "percent=excluded.percent, finished=excluded.finished, "
            "updated_at=excluded.updated_at",
            (row["path"], locator, float(position), float(percent),
             int(bool(finished)), db.now()))
    return {"ok": True}


def clear_progress(book_id: int) -> dict:
    with db.connect() as conn:
        row = conn.execute("SELECT path FROM books WHERE id=?", (book_id,)).fetchone()
        if not row:
            return {"ok": False, "reason": "no such book"}
        conn.execute("DELETE FROM reading WHERE path=?", (row["path"],))
    return {"ok": True}


def recent(limit: int = 60) -> list[dict]:
    """Books with reading progress, most recently opened first."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT r.percent, r.finished, r.updated_at, "
            "b.id, b.title, b.author, b.ext, b.format, b.volume, b.date, "
            "b.shelf, b.folder, b.root_label, b.is_dir, b.is_extra, "
            "c.state cover_state "
            "FROM reading r JOIN books b ON b.path=r.path "
            "LEFT JOIN covers c ON c.book_id=b.id "
            "ORDER BY r.updated_at DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]
