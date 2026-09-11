"""Walk the roots and rebuild the derived table.

The shelves are not laid out the same way everywhere, and the layout changes
over time, so nothing here is configured -- it is all read off the disk:

    a folder whose name starts with "["   is content: an author or a publisher
                                          owns it, so it either is one volume
                                          of page scans or holds several books
    any other folder directly under a root is a shelf (1. 連載中, 3. 完結 …)
    files sitting loose on a shelf         are books

Every file is one book and that is where it ends: nothing is grouped, inferred
or joined back together. A folder that holds books is recorded on each of them
as the place they sit in, and it lends them the author its own name credits,
but it is not a thing in the index of its own. Every recognised extension is a
format the shelf can count and filter by, `.txt` no differently from the rest.

A scan adds and updates; it does not delete. A book it did not find this time
is marked `present = 0` and keeps everything else it knew, because far and away
the likeliest reason a file is missing is that the drive holding it is not
plugged in. A root that could not be opened at all is skipped entirely rather
than being read as an empty one, so an unplugged drive marks nothing.
"""
from __future__ import annotations

import os
import time

from . import config, db
from .naming import is_extra, norm, parse_folder, parse_item, volume_of
from .config import BOOK_EXT, IMAGE_EXT, format_of


def _is_image_volume(path: str) -> bool:
    """A folder of page scans counts as one volume, not as a place."""
    try:
        entries = os.listdir(path)
    except OSError:
        return False
    imgs = books = 0
    for e in entries:
        ext = os.path.splitext(e)[1].lower()
        if ext in IMAGE_EXT:
            imgs += 1
        elif ext in BOOK_EXT:
            books += 1
    return imgs > 0 and books == 0


def _is_shelf(root_path: str, name: str) -> bool:
    """A folder directly under a root that groups books rather than being one.

    Content folders are named after whoever made the book and so start with a
    bracket; a shelf is named for a reading status. A folder of page scans is a
    book however it is named.
    """
    if name.startswith(("_", ".", "[")):
        return False
    full = os.path.join(root_path, name)
    return os.path.isdir(full) and not _is_image_volume(full)


def _shelves_of(root_path: str) -> list[str]:
    try:
        names = sorted(os.listdir(root_path))
    except OSError:
        return []
    return [n for n in names if _is_shelf(root_path, n)]


def _collect_books(folder: str, in_folder: bool) -> list[dict]:
    """Every book directly inside one folder, files and page-scan folders alike."""
    out: list[dict] = []
    try:
        entries = sorted(os.listdir(folder))
    except OSError:
        return out
    for name in entries:
        full = os.path.join(folder, name)
        if name.startswith(("_", ".")):
            continue
        if os.path.isdir(full):
            if not _is_image_volume(full):
                continue
            meta = parse_item(name + ".dir", in_folder)
            try:
                st = os.stat(full)
                size = sum(
                    os.path.getsize(os.path.join(full, f))
                    for f in os.listdir(full)
                    if os.path.isfile(os.path.join(full, f))
                )
            except OSError:
                st, size = None, 0
            out.append(dict(path=full, filename=name, ext="<dir>", is_dir=1,
                            size=size, mtime=st.st_mtime if st else 0, **meta))
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext not in BOOK_EXT:
            continue
        meta = parse_item(name, in_folder)
        try:
            st = os.stat(full)
        except OSError:
            continue
        out.append(dict(path=full, filename=name, ext=ext, is_dir=0,
                        size=st.st_size, mtime=st.st_mtime, **meta))
    return out


def scan(verbose: bool = True) -> dict:
    cfg = config.Config.load()
    db.init()
    started = time.time()
    stats = {"roots": 0, "books": 0, "new": 0, "updated": 0, "returned": 0,
             "vanished": 0, "formats": {}, "skipped_roots": []}
    scanned_roots: list[str] = []

    with db.connect() as conn:
        for root in cfg.roots:
            if not root.enabled:
                continue
            if not os.path.isdir(root.path):
                stats["skipped_roots"].append(root.path)
                continue
            stats["roots"] += 1
            scanned_roots.append(root.path)

            # The root itself is scanned as an unnamed shelf so loose books and
            # content folders sitting beside the shelves are not lost.
            shelves = _shelves_of(root.path)
            _scan_shelf(conn, root, "", root.path, set(shelves), stats)
            for shelf in shelves:
                _scan_shelf(conn, root, shelf, os.path.join(root.path, shelf),
                            set(), stats)

        _mark_absent(conn, scanned_roots, started, stats)

        db.set_meta(conn, "last_scan", {"at": time.time(),
                                        "seconds": round(time.time() - started, 2),
                                        **{k: v for k, v in stats.items()
                                           if k != "skipped_roots"}})

    stats["seconds"] = round(time.time() - started, 2)
    if verbose:
        kinds = ", ".join(f"{k} {n}" for k, n in
                          sorted(stats["formats"].items(), key=lambda kv: -kv[1]))
        print(f"scanned {stats['roots']} roots: {stats['books']} books found "
              f"in {stats['seconds']}s")
        print(f"  {stats['new']} new, {stats['updated']} changed, "
              f"{stats['returned']} back again, {stats['vanished']} not found")
        if kinds:
            print(f"  {kinds}")
        for p in stats["skipped_roots"]:
            print(f"  ! root not readable, nothing in it was touched: {p}")
    return stats


def _mark_absent(conn, scanned_roots, started, stats) -> None:
    """Flag what was not seen this time, without throwing any of it away.

    Only books under a root that was actually read are considered. A root that
    is not mounted was skipped above, so none of its books are called missing
    on the strength of a scan that never looked at them.

    The roots are matched by path prefix rather than by label, because labels
    are free text and nothing stops two roots from sharing one -- and a shared
    label would let a mounted drive declare an unmounted drive's books gone.
    The comparison is `substr` rather than `LIKE` so that the brackets and
    underscores these folder names are full of cannot act as wildcards.
    """
    if not scanned_roots:
        return
    where, args = [], [started]
    for path in scanned_roots:
        prefix = path if path.endswith(os.sep) else path + os.sep
        where.append("substr(path, 1, ?) = ?")
        args += [len(prefix), prefix]
    cur = conn.execute(
        f"UPDATE books SET present=0 WHERE present=1 AND last_seen < ? "
        f"AND ({' OR '.join(where)})", args)
    stats["vanished"] = cur.rowcount or 0


def _scan_shelf(conn, root, shelf, shelf_path, skip, stats) -> None:
    try:
        entries = sorted(os.listdir(shelf_path))
    except OSError:
        return

    # Books loose on the shelf itself.
    for book in _collect_books(shelf_path, in_folder=False):
        if os.path.basename(book["path"]) in skip:
            continue
        _insert(conn, root, shelf, "", None, book, stats)

    # Books inside a content folder. The folder is only a place, but its name
    # credits an author the files inside usually leave off.
    for name in entries:
        if name.startswith(("_", ".")) or name in skip:
            continue
        full = os.path.join(shelf_path, name)
        if not os.path.isdir(full) or _is_image_volume(full):
            continue
        credit = parse_folder(name)
        for book in _collect_books(full, in_folder=True):
            _insert(conn, root, shelf, name, credit, book, stats)


def _insert(conn, root, shelf, folder, credit, book, stats) -> None:
    """Record one book, updating the row already there rather than replacing it.

    `path` is the identity, so a book that has not moved keeps its id, and with
    it every cover already extracted for it. `first_seen` is only ever written
    once -- it is the one thing here the filesystem cannot say.
    """
    author = book.get("author") or (credit or {}).get("author")
    imprint = book.get("imprint") or (credit or {}).get("imprint")
    illustrator = book.get("illustrator") or (credit or {}).get("illustrator")
    title = book["title"]
    volume = volume_of(title)
    fmt = format_of(book["ext"], bool(book["is_dir"]))
    try:
        sort_vol = float(volume) if volume else 1e9
    except ValueError:
        sort_vol = 1e9

    now = db.now()
    before = conn.execute(
        "SELECT present, size, mtime, title, shelf, folder FROM books "
        "WHERE path=?", (book["path"],)).fetchone()

    conn.execute(
        "INSERT INTO books("
        "root_label,root_kind,shelf,folder,path,filename,title,author,imprint,"
        "illustrator,ext,format,date,volume,is_extra,is_dir,size,mtime,"
        "sort_date,sort_vol,norm_title,norm_author,present,first_seen,last_seen) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?) "
        "ON CONFLICT(path) DO UPDATE SET "
        "root_label=excluded.root_label, root_kind=excluded.root_kind, "
        "shelf=excluded.shelf, folder=excluded.folder, "
        "filename=excluded.filename, title=excluded.title, "
        "author=excluded.author, imprint=excluded.imprint, "
        "illustrator=excluded.illustrator, ext=excluded.ext, "
        "format=excluded.format, date=excluded.date, volume=excluded.volume, "
        "is_extra=excluded.is_extra, is_dir=excluded.is_dir, "
        "size=excluded.size, mtime=excluded.mtime, "
        "sort_date=excluded.sort_date, sort_vol=excluded.sort_vol, "
        "norm_title=excluded.norm_title, norm_author=excluded.norm_author, "
        "present=1, last_seen=excluded.last_seen",
        (root.label, root.kind, shelf, folder, book["path"], book["filename"],
         title, author, imprint, illustrator, book["ext"], fmt, book["date"],
         volume, int(is_extra(title)), book["is_dir"], book["size"],
         book["mtime"], book["date"] or "9999-99-99", sort_vol,
         norm(title), norm(author or ""), now, now),
    )

    stats["books"] += 1
    stats["formats"][fmt] = stats["formats"].get(fmt, 0) + 1
    if before is None:
        stats["new"] += 1
    elif not before["present"]:
        stats["returned"] += 1
    elif (before["size"] != book["size"] or before["mtime"] != book["mtime"]
          or before["title"] != title or before["shelf"] != shelf
          or before["folder"] != folder):
        stats["updated"] += 1
