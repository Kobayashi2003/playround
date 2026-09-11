"""Read-side queries shared by the web server and the CLI.

Everything is a book. A view is a filter over one table and a window of rows
out of it, which is what lets the shelf ask for exactly the page it is about to
draw and nothing else.
"""
from __future__ import annotations

from . import db
from .naming import norm

# What the shelf can be sorted by. Each is (SQL, label); the tie-breakers are
# fixed so paging is stable -- a row must never appear on two pages because two
# books share a date.
ORDERS = {
    "date": "b.sort_date DESC, b.sort_vol, b.norm_title, b.id",
    "date_asc": "b.sort_date, b.sort_vol, b.norm_title, b.id",
    "title": "b.norm_title, b.sort_date, b.id",
    "author": "b.norm_author='', b.norm_author, b.norm_title, b.sort_vol, b.id",
    "added": "b.mtime DESC, b.id",
    "format": "b.format, b.norm_author, b.norm_title, b.id",
}
DEFAULT_ORDER = "author"

# Columns the shelf grid needs. The full row is fetched only for one book at a
# time, so a page of 120 cards does not carry paths and sizes it never draws.
CARD_COLUMNS = ("b.id, b.title, b.author, b.shelf, b.folder, b.root_label, "
                "b.root_kind, b.date, b.volume, b.ext, b.format, b.is_extra, "
                "b.is_dir, b.present")


def overview() -> dict:
    """Counts the sidebar is built from: per shelf, per format, and in total."""
    with db.connect() as conn:
        shelves = conn.execute(
            "SELECT root_label, root_kind, shelf, COUNT(*) n_books, "
            "SUM(date IS NULL) n_undated, SUM(present=0) n_absent "
            "FROM books GROUP BY root_label, shelf "
            "ORDER BY root_label, shelf"
        ).fetchall()
        formats = conn.execute(
            "SELECT format, COUNT(*) n_books, SUM(size) bytes, "
            "SUM(present=0) n_absent "
            "FROM books GROUP BY format ORDER BY n_books DESC, format"
        ).fetchall()
        totals = conn.execute(
            "SELECT COUNT(*) n_books, SUM(date IS NULL) n_undated, "
            "SUM(present=0) n_absent, COUNT(DISTINCT format) n_formats, "
            "SUM(size) bytes FROM books"
        ).fetchone()
        n_trash = conn.execute("SELECT COUNT(*) c FROM trash").fetchone()["c"]
        last = db.get_meta(conn, "last_scan")
        epoch = db.get_meta(conn, "index_epoch")
    return {
        "shelves": [dict(r) for r in shelves],
        "formats": [dict(r) for r in formats],
        "totals": dict(totals) if totals else {},
        "n_trash": n_trash,
        # Which incarnation of the index this is. Ids survive a scan now, so
        # anything the browser keyed by one only has to be dropped when this
        # changes -- not every time the shelf is read off disk again.
        "index_epoch": epoch,
        "last_scan": last,
    }


def _filter(root, shelf, folder, q, only, fmt) -> tuple[str, list]:
    where, args = [], []
    if root:
        where.append("b.root_label=?")
        args.append(root)
    if shelf is not None and shelf != "":
        where.append("b.shelf=?")
        args.append(shelf)
    if folder is not None and folder != "":
        where.append("b.folder=?")
        args.append(folder)
    if fmt:
        # Several formats at once: `format=epub,pdf` is how the shelf asks for
        # "the ones I can actually read here".
        wanted = [f.strip().lstrip(".").lower() for f in str(fmt).split(",")
                  if f.strip()]
        if wanted:
            where.append(f"b.format IN ({','.join('?' * len(wanted))})")
            args += wanted
    if only == "undated":
        where.append("b.date IS NULL")
    elif only == "extra":
        where.append("b.is_extra=1")
    elif only == "absent":
        where.append("b.present=0")
    elif only == "present":
        where.append("b.present=1")
    if q:
        where.append("(b.norm_title LIKE ? OR b.norm_author LIKE ?)")
        like = f"%{norm(q)}%"
        args += [like, like]
    return (" WHERE " + " AND ".join(where)) if where else "", args


def books(root: str | None = None, shelf: str | None = None,
          folder: str | None = None, q: str | None = None,
          only: str | None = None, fmt: str | None = None,
          order: str | None = None, offset: int = 0, limit: int = 120) -> dict:
    """One page of the shelf, with the cover each card should draw."""
    clause, args = _filter(root, shelf, folder, q, only, fmt)
    by = ORDERS.get(order or DEFAULT_ORDER, ORDERS[DEFAULT_ORDER])

    with db.connect() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) c FROM books b{clause}", args).fetchone()["c"]
        rows = conn.execute(
            f"SELECT {CARD_COLUMNS}, c.state cover_state, "
            "r.percent read_percent, r.finished read_finished "
            "FROM books b LEFT JOIN covers c ON c.book_id=b.id "
            f"LEFT JOIN reading r ON r.path=b.path{clause} "
            f"ORDER BY {by} LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
        # What the format filter could still narrow to, counted under every
        # *other* filter that is active. A format offering nothing here is not
        # offered at all, so the control never leads anywhere empty.
        facets = conn.execute(
            f"SELECT b.format, COUNT(*) n FROM books b{clause} "
            "GROUP BY b.format ORDER BY n DESC, b.format",
            args).fetchall() if not fmt else []
    return {"total": total, "offset": offset, "limit": limit,
            "order": order or DEFAULT_ORDER, "format": fmt,
            "facets": [dict(r) for r in facets],
            "books": [dict(r) for r in rows]}


def book(book_id: int) -> dict | None:
    """One book in full, plus the other files in the folder it sits in.

    That is a fact about the disk rather than a claim about which books belong
    together, and it only means anything when there is a folder: a book lying
    loose on a shelf shares that shelf with a thousand others, and listing them
    would say nothing at all.
    """
    with db.connect() as conn:
        row = conn.execute(
            "SELECT b.*, c.state cover_state, c.source cover_source, "
            "r.percent read_percent, r.locator read_locator, "
            "r.position read_position, r.finished read_finished, "
            "r.updated_at read_at "
            "FROM books b LEFT JOIN covers c ON c.book_id=b.id "
            "LEFT JOIN reading r ON r.path=b.path WHERE b.id=?",
            (book_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        near = [] if not d["folder"] else conn.execute(
            f"SELECT {CARD_COLUMNS}, c.state cover_state "
            "FROM books b LEFT JOIN covers c ON c.book_id=b.id "
            "WHERE b.root_label=? AND b.shelf=? AND b.folder=? "
            "ORDER BY b.sort_date, b.sort_vol, b.norm_title, b.id LIMIT 200",
            (d["root_label"], d["shelf"], d["folder"])).fetchall()
    return {"book": d, "nearby": [dict(r) for r in near]}


def formats(root: str | None = None, shelf: str | None = None) -> dict:
    """How the collection breaks down by file format, with what it costs.

    This is the whole of the "what have I got, and as what?" question now that
    a `.txt` is a text file rather than a volume that is missing.
    """
    clause, args = _filter(root, shelf, None, None, None, None)
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT b.format, COUNT(*) n_books, SUM(b.size) bytes, "
            "SUM(b.is_dir) n_dirs, MIN(b.date) first_date, MAX(b.date) last_date, "
            "COUNT(DISTINCT b.norm_author) n_authors "
            f"FROM books b{clause} GROUP BY b.format "
            "ORDER BY n_books DESC, b.format", args).fetchall()
        by_shelf = conn.execute(
            "SELECT b.root_label, b.shelf, b.format, COUNT(*) n_books "
            f"FROM books b{clause} GROUP BY b.root_label, b.shelf, b.format "
            "ORDER BY b.root_label, b.shelf, n_books DESC", args).fetchall()
    return {"formats": [dict(r) for r in rows],
            "by_shelf": [dict(r) for r in by_shelf]}


def folders(root: str | None = None, shelf: str | None = None) -> dict:
    """The content folders on a shelf, for jumping straight to one of them."""
    clause, args = _filter(root, shelf, None, None, None, None)
    extra = " AND b.folder<>''" if clause else " WHERE b.folder<>''"
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT b.root_label, b.shelf, b.folder, COUNT(*) n_books, "
            "MIN(b.author) author, COUNT(DISTINCT b.format) n_formats "
            f"FROM books b{clause}{extra} "
            "GROUP BY b.root_label, b.shelf, b.folder "
            "ORDER BY b.root_label, b.shelf, b.folder", args).fetchall()
    return {"folders": [dict(r) for r in rows]}
