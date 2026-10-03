"""Walk the roots and rebuild the derived table.

The shelves are not laid out the same way everywhere, and the layout changes
over time, so almost nothing here is configured -- it is read off the disk:

    a folder whose name starts with "["   is content: an author or a publisher
                                          owns it, so it either is one volume
                                          of page scans or holds several books
    any other folder directly under a root is a shelf (1. 連載中, EPUB …)
    files sitting loose on a shelf         are books
    a folder that holds images and no books is one volume of page scans

Below a shelf, folders are walked to any depth: a collection that was unpacked
from archives can bury a volume five folders down, and it is still a volume.
The one thing a root can say about itself is its `layout` -- `authors` means
the folders directly under it are authors rather than shelves, which is how a
Calibre export is arranged (Author/Title - Author.epub).

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
from .naming import (is_extra, natural, norm, parse_folder, parse_item,
                     split_author_suffix, volume_of)
from .config import BOOK_EXT, IMAGE_EXT, format_of


# A folder of page scans named like this is named for what it holds, not for
# the book; the book's name is on the folder above it.
GENERIC_IMAGE_DIRS = {"images", "image", "img", "imgs", "pages", "page",
                      "scans", "scan", "jpg", "jpeg", "png"}
MAX_DEPTH = 12                  # a guard against a link loop, not a real limit


def _list(path: str) -> tuple[list, list]:
    """The files and folders in one directory, sorted, hidden ones left out.

    Every directory is listed exactly once per scan and the listing is handed
    down, because on a collection of a hundred thousand files the listing *is*
    the scan.
    """
    try:
        with os.scandir(path) as it:
            entries = sorted(it, key=lambda e: e.name)
    except OSError:
        return [], []
    files, dirs = [], []
    for e in entries:
        if e.name.startswith(("_", ".")):
            continue
        try:
            if e.is_dir(follow_symlinks=False):
                dirs.append(e)
            elif e.is_file():
                files.append(e)
        except OSError:
            continue
    return files, dirs


def _holds_only_images(files) -> bool:
    imgs = books = 0
    for f in files:
        ext = os.path.splitext(f.name)[1].lower()
        if ext in IMAGE_EXT:
            imgs += 1
        elif ext in BOOK_EXT:
            books += 1
    return imgs > 0 and books == 0


def _is_image_volume(path: str) -> bool:
    """A folder of page scans counts as one volume, not as a place."""
    files, _ = _list(path)
    return _holds_only_images(files)


def _shelves_of(root_path: str) -> list[str]:
    """Folders directly under a root that group books rather than being one.

    Content folders are named after whoever made the book and so start with a
    bracket; a shelf is named for a reading status or a format. A folder of
    page scans is a book however it is named.
    """
    _, dirs = _list(root_path)
    return [d.name for d in dirs
            if not d.name.startswith("[") and not _is_image_volume(d.path)]


def _file_book(entry, credit: dict | None) -> dict | None:
    ext = os.path.splitext(entry.name)[1].lower()
    if ext not in BOOK_EXT:
        return None
    # Inside a folder that credits someone, the files usually carry only a date
    # and a title, and a lone tag there is not a second author. Inside a folder
    # that credits no one, the file's own tags are all there is.
    meta = parse_item(entry.name, in_folder=bool(credit and credit.get("author")))
    try:
        st = entry.stat()
    except OSError:
        return None
    return dict(path=entry.path, filename=entry.name, ext=ext, is_dir=0,
                size=st.st_size, mtime=st.st_mtime, **meta)


def _folder_book(entry, files, parent_name: str, credit: dict | None) -> dict:
    name = entry.name
    if name.lower() in GENERIC_IMAGE_DIRS and parent_name:
        name = parent_name
    meta = parse_item(name + ".dir", in_folder=bool(credit and credit.get("author")))
    size = 0
    for f in files:
        try:
            size += f.stat().st_size
        except OSError:
            pass
    try:
        mtime = entry.stat().st_mtime
    except OSError:
        mtime = 0
    return dict(path=entry.path, filename=entry.name, ext="<dir>", is_dir=1,
                size=size, mtime=mtime, **meta)


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

            if root.layout == "authors":
                # The whole root is one shelf, and every folder directly under
                # it is someone's name.
                _walk(conn, root, "", root.path, "", None, stats,
                      skip=set(), authors=True)
                continue

            # The root itself is scanned as an unnamed shelf so loose books and
            # content folders sitting beside the shelves are not lost.
            shelves = _shelves_of(root.path)
            _walk(conn, root, "", root.path, "", None, stats, skip=set(shelves))
            for shelf in shelves:
                _walk(conn, root, shelf, os.path.join(root.path, shelf), "",
                      None, stats, skip=set())

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


def _walk(conn, root, shelf, base, rel, credit, stats, skip,
          authors: bool = False, depth: int = 0, listing=None) -> None:
    """Record every book in one folder of a shelf, then everything below it.

    `rel` is where this folder sits inside the shelf ("" for the shelf itself);
    it is what a book records as its `folder`, so the books beside it are the
    books in the same directory and nothing else. `credit` is the nearest
    folder above that names an author, which the files below inherit.
    """
    if depth > MAX_DEPTH:
        return
    here = os.path.join(base, *rel.split("/")) if rel else base
    files, dirs = listing if listing is not None else _list(here)
    folder_name = rel.rsplit("/", 1)[-1] if rel else ""

    for entry in files:
        book = _file_book(entry, credit)
        if book:
            _insert(conn, root, shelf, rel, credit, book, stats)

    for entry in dirs:
        if entry.name in skip:
            continue
        sub_files, sub_dirs = _list(entry.path)
        if _holds_only_images(sub_files):
            book = _folder_book(entry, sub_files, folder_name, credit)
            _insert(conn, root, shelf, rel, credit, book, stats)
            continue

        if authors and depth == 0:
            # Author/... -- the folder's name is the credit, brackets or not.
            sub_credit = {"author": entry.name, "imprint": None,
                          "illustrator": None}
        else:
            own = parse_folder(entry.name)
            sub_credit = own if own.get("author") else credit
        sub_rel = f"{rel}/{entry.name}" if rel else entry.name
        _walk(conn, root, shelf, base, sub_rel, sub_credit, stats, set(),
              authors=authors, depth=depth + 1, listing=(sub_files, sub_dirs))


def _insert(conn, root, shelf, folder, credit, book, stats) -> None:
    """Record one book, updating the row already there rather than replacing it.

    `path` is the identity, so a book that has not moved keeps its id, and with
    it every cover already extracted for it. `first_seen` is only ever written
    once -- it is the one thing here the filesystem cannot say.
    """
    credited = (credit or {}).get("author")
    title, written = split_author_suffix(book["title"], credited)
    # The file's own tags first, then the name as the file writes it, then the
    # name as the folder files it.
    author = book.get("author") or written or credited
    imprint = book.get("imprint") or (credit or {}).get("imprint")
    illustrator = book.get("illustrator") or (credit or {}).get("illustrator")
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
        "sort_date,sort_vol,norm_title,norm_author,nat_title,"
        "present,first_seen,last_seen) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?) "
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
        "nat_title=excluded.nat_title, "
        "present=1, last_seen=excluded.last_seen",
        (root.label, root.kind, shelf, folder, book["path"], book["filename"],
         title, author, imprint, illustrator, book["ext"], fmt, book["date"],
         volume, int(is_extra(title)), book["is_dir"], book["size"],
         book["mtime"], book["date"] or "9999-99-99", sort_vol,
         norm(title), norm(author or ""), natural(title), now, now),
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
