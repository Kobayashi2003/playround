"""Walk the roots and rebuild the derived tables.

The shelves are not laid out the same way everywhere, and the layout changes
over time, so nothing here is configured -- it is all read off the disk:

    a folder whose name starts with "["   is content: an author or a publisher
                                          owns it, so it is a series or a
                                          scanned volume
    any other folder directly under a root is a shelf (1. 連載中, 3. 完結 …)
    files sitting loose on a shelf         are books

Novels now live as a flat pile of files on each shelf rather than in per-series
folders, so their series is recovered from the titles by `naming.series_of`;
that is what keeps a volume next to the .txt placeholder standing in for the
one after it. Comics and artbooks still use folders, and both shapes are
scanned side by side without being told which is which.
"""
from __future__ import annotations

import os
import time

from . import config, db
from .naming import guess_volume, is_extra, norm, parse_item, parse_series_dir, series_of
from .config import BOOK_EXT, IMAGE_EXT, MISSING_EXT


def _is_image_volume(path: str) -> bool:
    """A folder of page scans counts as one volume, not as a series."""
    try:
        entries = os.listdir(path)
    except OSError:
        return False
    imgs = books = 0
    for e in entries:
        ext = os.path.splitext(e)[1].lower()
        if ext in IMAGE_EXT:
            imgs += 1
        elif ext in BOOK_EXT or ext in MISSING_EXT:
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


def _collect_items(folder: str, in_series_dir: bool) -> list[dict]:
    out: list[dict] = []
    try:
        entries = sorted(os.listdir(folder))
    except OSError:
        return out
    for name in entries:
        full = os.path.join(folder, name)
        if name.startswith("_") or name.startswith("."):
            continue
        if os.path.isdir(full):
            if _is_image_volume(full):
                meta = parse_item(name + ".dir", in_series_dir)
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
                                is_missing=0, size=size,
                                mtime=st.st_mtime if st else 0, **meta))
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext not in BOOK_EXT and ext not in MISSING_EXT:
            continue
        meta = parse_item(name, in_series_dir)
        try:
            st = os.stat(full)
        except OSError:
            continue
        out.append(dict(path=full, filename=name, ext=ext, is_dir=0,
                        is_missing=1 if ext in MISSING_EXT else 0,
                        size=st.st_size, mtime=st.st_mtime, **meta))
    return out


def scan(verbose: bool = True) -> dict:
    cfg = config.Config.load()
    db.init()
    started = time.time()
    stats = {"roots": 0, "series": 0, "items": 0, "missing": 0, "skipped_roots": []}

    with db.connect() as conn:
        conn.execute("DELETE FROM items")
        conn.execute("DELETE FROM series")

        for root in cfg.roots:
            if not root.enabled:
                continue
            if not os.path.isdir(root.path):
                stats["skipped_roots"].append(root.path)
                continue
            stats["roots"] += 1

            # The root itself is scanned as an unnamed shelf so loose books
            # and series folders sitting beside the shelves are not lost.
            shelves = _shelves_of(root.path)
            skip = set(shelves)
            _scan_shelf(conn, root, "", root.path, skip, stats)
            for shelf in shelves:
                _scan_shelf(conn, root, shelf, os.path.join(root.path, shelf),
                            set(), stats)

        db.set_meta(conn, "last_scan", {"at": time.time(),
                                        "seconds": round(time.time() - started, 2),
                                        **{k: v for k, v in stats.items()
                                           if k != "skipped_roots"}})

    stats["seconds"] = round(time.time() - started, 2)
    if verbose:
        print(f"scanned {stats['roots']} roots: {stats['series']} series, "
              f"{stats['items']} items ({stats['missing']} missing) "
              f"in {stats['seconds']}s")
        for p in stats["skipped_roots"]:
            print(f"  ! root not found: {p}")
    return stats


def _scan_shelf(conn, root, shelf, shelf_path, skip, stats) -> None:
    try:
        entries = sorted(os.listdir(shelf_path))
    except OSError:
        return

    # Folders that hold a series. A folder of page scans is one volume, not a
    # series, so it falls through to the loose pass below.
    for name in entries:
        if name.startswith(("_", ".")) or name in skip:
            continue
        full = os.path.join(shelf_path, name)
        if not os.path.isdir(full) or _is_image_volume(full):
            continue
        author, title = parse_series_dir(name)
        items = _collect_items(full, in_series_dir=True)
        if not items:
            continue
        _insert_series(conn, root, shelf, author, title, full,
                       is_flat=False, items=items, stats=stats)

    # Loose books, grouped into the series their titles imply.
    loose = [it for it in _collect_items(shelf_path, in_series_dir=False)
             if os.path.basename(it["path"]) not in skip]
    groups: dict[tuple[str, str], dict] = {}
    for it in loose:
        base, volume = series_of(it["title"])
        it["volume_hint"] = volume
        key = (norm(it.get("author") or ""), norm(base))
        g = groups.get(key)
        if g is None:
            groups[key] = {"author": it.get("author"), "title": base,
                           "items": [it]}
        else:
            g["items"].append(it)

    for g in groups.values():
        items = g["items"]
        # The opening volume of a series usually carries no number at all --
        # it is simply the series name. Give it one, but only when exactly one
        # volume is unnumbered, so a side story cannot be mistaken for it.
        if len(items) > 1:
            blank = [it for it in items
                     if not it["volume_hint"] and not is_extra(it["title"])]
            if len(blank) == 1:
                blank[0]["volume_hint"] = "1"
        # A group of one keeps its own title: calling a standalone book by a
        # stripped-down series name would only lose information.
        title = g["title"] if len(items) > 1 else items[0]["title"]
        path = shelf_path if len(items) > 1 else items[0]["path"]
        _insert_series(conn, root, shelf, g["author"], title, path,
                       is_flat=True, items=items, stats=stats)


def _insert_series(conn, root, shelf, author, title, path, is_flat, items, stats):
    key = db.series_key(author, title)
    dates = [i["date"] for i in items if i["date"]]
    n_missing = sum(1 for i in items if i["is_missing"])
    cur = conn.execute(
        "INSERT INTO series(root_label,root_kind,shelf,author,title,path,is_flat,"
        "n_items,n_missing,n_undated,first_date,last_date,series_key) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (root.label, root.kind, shelf, author, title, path, int(is_flat),
         len(items), n_missing, sum(1 for i in items if not i["date"]),
         min(dates) if dates else None, max(dates) if dates else None, key),
    )
    sid = cur.lastrowid
    stats["series"] += 1

    for it in items:
        vol = it.get("volume_hint") or guess_volume(
            it["title"], title if len(items) > 1 else None)
        # The first volume rarely carries a number; if the title is exactly the
        # series name then that is what it is.
        if vol is None and len(items) > 1 and not is_extra(it["title"])                 and norm(it["title"]) == norm(title):
            vol = "1"
        try:
            sort_vol = float(vol) if vol else 1e9
        except ValueError:
            sort_vol = 1e9
        conn.execute(
            "INSERT OR IGNORE INTO items(series_id,path,filename,title,ext,date,volume,"
            "is_missing,is_extra,is_dir,size,mtime,sort_date,sort_vol) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, it["path"], it["filename"], it["title"], it["ext"], it["date"], vol,
             it["is_missing"], int(is_extra(it["title"])), it["is_dir"],
             it["size"], it["mtime"], it["date"] or "9999-99-99", sort_vol),
        )
        stats["items"] += 1
        if it["is_missing"]:
            stats["missing"] += 1

