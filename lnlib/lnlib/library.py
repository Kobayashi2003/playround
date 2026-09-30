"""Taking books off the shelf, and putting them back.

`queries` reads the index; everything that changes it is here. There is one
rule the whole module is built around: nothing is destroyed in a single step.

    forget_many()   the records go to the trash, the files are not touched
    discard_many()  the records go to the trash and the files go with them
    retire()        the same, for a file already confirmed gone
    restore()       both come back, exactly as they were
    empty()         the only operation that actually deletes anything

Everything that removes books is a batch, because one book is a batch of one
and two code paths for the same act would drift apart. A batch never stops at
the first failure -- one locked file is no reason to leave the other nine
hundred where they were -- and reports, per book, what could not be done.

The file trash is a `_trash` folder inside the book's own root, not a folder
under `data/`. Two reasons, and both matter: a folder whose name starts with
`_` is already skipped by the scanner, so trashed books stay out of the index
without a special case anywhere; and it is on the same drive as the book, so
trashing a fourteen-gigabyte folder of scans is a rename rather than a copy.
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import time

from . import config, db

TRASH_DIR = "_trash"


def _root_for(path: str, roots: list | None = None) -> config.Root | None:
    """The configured root a path lies under, by longest match.

    `roots` lets a batch read the configuration once instead of once per book.
    """
    if roots is None:
        roots = config.Config.load().roots
    target = os.path.normcase(os.path.abspath(path))
    best: config.Root | None = None
    best_base = ""
    for root in roots:
        base = os.path.normcase(os.path.abspath(root.path))
        if target != base and not target.startswith(base + os.sep):
            continue
        # Both sides of the comparison have to be the normalised form, or a
        # root configured by a relative path is measured against the wrong
        # string and a shorter root can win.
        if best is None or len(base) > len(best_base):
            best, best_base = root, base
    return best


def root_is_reachable(path: str, roots: list | None = None) -> bool:
    """Whether the drive holding this book is actually there right now.

    A file that is missing because its root is not mounted says nothing about
    the book, so no conclusion is drawn from its absence.
    """
    root = _root_for(path, roots)
    return bool(root and os.path.isdir(root.path))


def _unique(dest: str) -> str:
    """A destination that does not already exist, keeping the original name."""
    if not os.path.exists(dest):
        return dest
    stem, ext = os.path.splitext(dest)
    for n in range(2, 1000):
        candidate = f"{stem} ({n}){ext}"
        if not os.path.exists(candidate):
            return candidate
    return f"{stem} ({int(time.time())}){ext}"


def _to_trash(path: str, roots: list | None = None) -> str:
    """Move a file or folder into its root's trash. Returns where it landed."""
    root = _root_for(path, roots)
    if not root:
        raise ValueError("this book is not under any configured root")
    if not os.path.isdir(root.path):
        raise FileNotFoundError(f"root not available: {root.path}")

    # Dated folders, so a trash that has been sitting for months can be read.
    day = time.strftime("%Y-%m-%d")
    bin_dir = os.path.join(root.path, TRASH_DIR, day)
    os.makedirs(bin_dir, exist_ok=True)
    dest = _unique(os.path.join(bin_dir, os.path.basename(path)))
    shutil.move(path, dest)
    return dest


def _row(conn, book_id: int):
    return conn.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()


def _bin_it(conn, row, file_state: str, trash_path: str | None,
            reason: str) -> int:
    """Move one books row into `trash`, keeping all of it."""
    payload = json.dumps(dict(row), ensure_ascii=False, default=str)
    cur = conn.execute(
        "INSERT INTO trash(path,title,author,format,size,row,file_state,"
        "trash_path,reason,trashed_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (row["path"], row["title"], row["author"], row["format"], row["size"],
         payload, file_state, trash_path, reason, db.now()))
    conn.execute("DELETE FROM books WHERE id=?", (row["id"],))
    return cur.lastrowid


def retire(book_id: int, reason: str = "vanished") -> dict:
    """Drop the record of a book whose file has been confirmed gone.

    This is what opening a missing book does. It is the one moment the absence
    has actually been tested rather than inferred from a scan, so it is the one
    moment the row is allowed to leave the index on its own. The row still goes
    to the trash, so a file that turns up again brings its reading history with
    it -- and if the root is not mounted, nothing happens at all.
    """
    with db.connect() as conn:
        row = _row(conn, book_id)
        if not row:
            return {"ok": False, "reason": "no such book"}
        path = row["path"]
        if os.path.exists(path):
            conn.execute("UPDATE books SET present=1 WHERE id=?", (book_id,))
            return {"ok": False, "reason": "the file is there after all"}
        if not root_is_reachable(path):
            conn.execute("UPDATE books SET present=0 WHERE id=?", (book_id,))
            return {"ok": False, "reason": "root not available",
                    "detail": "ドライブが見つからないため記録は残しました"}
        trash_id = _bin_it(conn, row, "vanished", None, reason)
    return {"ok": True, "trash_id": trash_id, "file_state": "vanished",
            "title": row["title"]}


def trash(limit: int = 200, offset: int = 0) -> dict:
    with db.connect() as conn:
        total = conn.execute("SELECT COUNT(*) c FROM trash").fetchone()["c"]
        rows = conn.execute(
            "SELECT id, path, title, author, format, size, file_state, "
            "trash_path, reason, trashed_at FROM trash "
            "ORDER BY trashed_at DESC LIMIT ? OFFSET ?",
            (limit, offset)).fetchall()
    return {"total": total, "items": [dict(r) for r in rows]}


def restore(trash_id: int) -> dict:
    """Put a book back: the file first, then the row it had.

    The row is written with its original id, so covers already extracted for it
    and anything else keyed by that id line up again.
    """
    with db.connect() as conn:
        entry = conn.execute("SELECT * FROM trash WHERE id=?",
                             (trash_id,)).fetchone()
        if not entry:
            return {"ok": False, "reason": "not in the trash"}

    row = json.loads(entry["row"])
    path = entry["path"]

    if entry["file_state"] == "trashed" and entry["trash_path"]:
        if not os.path.exists(entry["trash_path"]):
            return {"ok": False, "reason": "the trashed file is no longer there"}
        if os.path.exists(path):
            return {"ok": False, "reason": "something is already at that path"}
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            shutil.move(entry["trash_path"], path)
        except OSError as e:
            return {"ok": False, "reason": f"{type(e).__name__}: {e}"}

    row["present"] = 1 if os.path.exists(path) else 0

    with db.connect() as conn:
        # Only the columns this schema actually has. A record written by an
        # older version can carry a field that has since been dropped, and that
        # is not a reason to refuse to give someone their book back.
        columns = [c["name"] for c in conn.execute("PRAGMA table_info(books)")
                   if c["name"] in row]
        marks = ",".join("?" * len(columns))
        try:
            conn.execute(
                f"INSERT INTO books({','.join(columns)}) VALUES({marks})",
                [row[c] for c in columns])
        except sqlite3.IntegrityError:
            # The id or the path is taken again -- a rescan found the book
            # before the restore did. The shelf already has it, so the only
            # thing left to do below is drop the trash entry.
            pass

        # The trash entry is the only remaining record of this book, so it is
        # dropped only once the book is demonstrably back on the shelf. Any
        # other failure leaves the entry in place to be tried again rather
        # than losing it along with the row it was standing in for.
        back = conn.execute("SELECT 1 FROM books WHERE path=?",
                            (path,)).fetchone()
        if not back:
            return {"ok": False,
                    "reason": "記録を戻せませんでした。ゴミ箱には残っています"}
        conn.execute("DELETE FROM trash WHERE id=?", (trash_id,))
    return {"ok": True, "title": entry["title"], "present": row["present"]}


def empty(trash_id: int | None = None, older_than_days: float | None = None,
          trash_ids: list[int] | None = None) -> dict:
    """Delete for real. Nothing else in this module does.

    Files that were only ever recorded (`kept`) are left alone: forgetting a
    book was never a claim on the file, and emptying the trash must not become
    a way to delete one by surprise.

    An entry is dropped only once its file is actually gone. If a file cannot
    be deleted -- open in another program, say -- its entry stays, so the file
    is not left sitting in `_trash` with nothing pointing at it.
    """
    where, args = [], []
    if trash_id is not None:
        where.append("id=?")
        args.append(trash_id)
    if older_than_days is not None:
        where.append("trashed_at < ?")
        args.append(time.time() - older_than_days * 86400)
    if trash_ids is not None:
        if not trash_ids:
            return {"ok": True, "entries": 0, "files_deleted": 0,
                    "files_kept": 0, "failed": 0}
        where.append(f"id IN ({','.join('?' * len(trash_ids))})")
        args += list(trash_ids)
    clause = (" WHERE " + " AND ".join(where)) if where else ""

    with db.connect() as conn:
        rows = conn.execute(f"SELECT * FROM trash{clause}", args).fetchall()

    deleted = failed = kept = 0
    done: list[int] = []
    for entry in rows:
        target = entry["trash_path"]
        if entry["file_state"] != "trashed" or not target:
            kept += 1
            done.append(entry["id"])
            continue
        try:
            if os.path.isdir(target):
                shutil.rmtree(target)
            elif os.path.exists(target):
                os.remove(target)
            deleted += 1
            done.append(entry["id"])
        except OSError:
            failed += 1

    with db.connect() as conn:
        for chunk in _chunks(done):
            conn.execute(f"DELETE FROM trash WHERE id IN ({','.join('?' * len(chunk))})",
                         chunk)
    return {"ok": True, "entries": len(done), "files_deleted": deleted,
            "files_kept": kept, "failed": failed}


# ------------------------------------------------------------------ batches
BATCH_COMMIT = 50               # rows between commits while files are moving
MAX_REPORTED = 50               # failures listed back; the rest are counted


def _chunks(items: list, size: int = 500):
    """SQLite caps the number of `?` in one statement; stay well under it."""
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _report(total: int, done: int, failures: list[dict]) -> dict:
    return {"ok": not failures, "total": total, "done": done,
            "failed": len(failures), "failures": failures[:MAX_REPORTED]}


def forget_many(book_ids: list[int]) -> dict:
    """Take many books off the shelf; no file is touched."""
    ids = list(dict.fromkeys(book_ids))
    done, failures = 0, []
    with db.connect() as conn:
        for book_id in ids:
            row = _row(conn, book_id)
            if not row:
                failures.append({"id": book_id, "reason": "no such book"})
                continue
            _bin_it(conn, row, "kept", None, "deleted")
            done += 1
    return _report(len(ids), done, failures)


def discard_many(book_ids: list[int]) -> dict:
    """Take many books off the shelf and move each file to its root's trash.

    Book by book, and in the same order as `discard`: the file moves first and
    the row follows, so an interrupted batch leaves every book either fully
    done or fully untouched. Rows are committed in small groups so a crash
    part-way through does not lose the record of files already moved.
    """
    ids = list(dict.fromkeys(book_ids))
    roots = config.Config.load().roots
    done, failures = 0, []
    with db.connect() as conn:
        for n, book_id in enumerate(ids, 1):
            row = _row(conn, book_id)
            if not row:
                failures.append({"id": book_id, "reason": "no such book"})
                continue
            path = row["path"]
            if not os.path.exists(path):
                if root_is_reachable(path, roots):
                    _bin_it(conn, row, "vanished", None, "vanished")
                    done += 1
                else:
                    failures.append({"id": book_id, "title": row["title"],
                                     "reason": "ドライブが見つかりません"})
                continue
            try:
                landed = _to_trash(path, roots)
            except (OSError, ValueError) as e:
                failures.append({"id": book_id, "title": row["title"],
                                 "reason": f"{type(e).__name__}: {e}"})
                continue
            _bin_it(conn, row, "trashed", landed, "deleted")
            done += 1
            if n % BATCH_COMMIT == 0:
                conn.commit()
    return _report(len(ids), done, failures)


def restore_many(trash_ids: list[int]) -> dict:
    """Put many books back. Each is restored exactly as `restore` would."""
    ids = list(dict.fromkeys(trash_ids))
    done, failures = 0, []
    for trash_id in ids:
        res = restore(trash_id)
        if res.get("ok"):
            done += 1
        else:
            failures.append({"id": trash_id, "title": res.get("title"),
                             "reason": res.get("reason", "failed")})
    return _report(len(ids), done, failures)


def clear_progress_many(book_ids: list[int]) -> dict:
    """Forget where reading had got to in many books at once."""
    ids = list(dict.fromkeys(book_ids))
    cleared = 0
    with db.connect() as conn:
        for chunk in _chunks(ids):
            cur = conn.execute(
                "DELETE FROM reading WHERE path IN (SELECT path FROM books "
                f"WHERE id IN ({','.join('?' * len(chunk))}))", chunk)
            cleared += cur.rowcount or 0
    return {"ok": True, "total": len(ids), "done": cleared, "failed": 0,
            "failures": []}


def drop_root(path: str) -> dict:
    """Forget every book under a root that is no longer part of the library.

    This is different from a drive being unplugged. A root that is still in
    the configuration but cannot be read is left entirely alone; a root that
    has been *removed* from the configuration is never scanned again, so its
    books would otherwise sit on the shelf indefinitely, looking present.

    Only index rows go. The files are not touched, reading progress is keyed by
    path and stays, and the cover images on disk are found again by path hash
    -- so adding the root back and scanning brings everything back as it was.
    """
    prefix = os.path.abspath(path)
    prefix = prefix if prefix.endswith(os.sep) else prefix + os.sep
    with db.connect() as conn:
        cur = conn.execute("DELETE FROM books WHERE substr(path, 1, ?) = ?",
                           (len(prefix), prefix))
        removed = cur.rowcount or 0
        if removed:
            # A different set of books entirely: the browser's thumbnails for
            # these can go. Ids are never reused, so this is housekeeping --
            # it frees the space rather than preventing a wrong cover.
            db.set_meta(conn, "index_epoch", time.time())
    return {"removed": removed}
