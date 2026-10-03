"""Command line interface. Every command prints JSON when given --json.

The web UI is the place to actually read a book; these commands exist to build
and inspect the index without opening a browser.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

from . import config, coverjob, db, library, queries, reader
from . import scan as scanner


def _gb(n) -> str:
    """Bytes as something readable; the sizes here run from KB to hundreds of GB."""
    size = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.0f} {unit}" if unit in ("B", "KB") else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def _out(obj, as_json: bool):
    if as_json:
        print(json.dumps(obj, ensure_ascii=False, indent=1, default=str))
    return obj


def cmd_scan(a):
    st = scanner.scan(verbose=not a.json)
    return _out(st, a.json)


def cmd_serve(a):
    from .server import serve
    serve(host=a.host, port=a.port, open_browser=not a.no_browser,
          base_path=a.base_path)


def cmd_covers(a):
    def prog(done, total):
        print(f"  {done}/{total}", flush=True)
    res = coverjob.build(limit=a.limit, redo=a.redo,
                         progress=None if a.json else prog)
    if not a.json:
        print(f"covers: {res['ok']} ok, {res['none']} none, {res['error']} error "
              f"(of {res['processed']})")
    return _out(res, a.json)


def cmd_overview(a):
    ov = queries.overview()
    if not a.json:
        t = ov["totals"]
        print(f"{t.get('n_books', 0)} books in {t.get('n_formats', 0)} formats "
              f"/ {t.get('n_undated', 0)} undated "
              f"/ {_gb(t.get('bytes'))}")
        for row in ov["shelves"]:
            print(f"  {row['root_label']:<14} {row['shelf'] or '(flat)':<18} "
                  f"books={row['n_books']:<6} undated={row['n_undated']}")
        print()
        for row in ov["formats"]:
            print(f"  {row['format']:<10} {row['n_books']:>6}  {_gb(row['bytes'])}")
    return _out(ov, a.json)


def _print_books(rows):
    for b in rows:
        mark = "extra" if b["is_extra"] else ""
        pct = b.get("read_percent")
        read = f"{round(pct * 100)}%" if pct else ""
        print(f"  [{b['id']:>6}] {b['format']:<7} {b['date'] or '        '}  "
              f"[{(b['author'] or '?')[:14]:<14}] {b['title'][:46]:<46} "
              f"{mark} {read}")


def cmd_books(a):
    res = queries.books(root=a.root, shelf=a.shelf, folder=a.folder, q=a.q,
                        only=a.only, fmt=a.format, order=a.order,
                        offset=a.offset, limit=a.limit)
    if not a.json:
        print(f"{res['total']} books")
        _print_books(res["books"])
        if res["facets"]:
            print("  by format: " + ", ".join(
                f"{f['format']} {f['n']}" for f in res["facets"]))
    return _out(res, a.json)


def cmd_show(a):
    d = queries.book(a.id)
    if not d:
        print("no such book", file=sys.stderr)
        return None
    if not a.json:
        b = d["book"]
        print(f"[{b['author'] or '?'}] {b['title']}")
        print(f"  {b['root_label']} / {b['shelf'] or '(flat)'}"
              f"{' / ' + b['folder'] if b['folder'] else ''}")
        print(f"  {b['path']}")
        print(f"  {b['ext']}  {b['date'] or 'no date'}  "
              f"{'第' + b['volume'] + '巻' if b['volume'] else ''}")
        if d["nearby"]:
            print(f"  beside it in the same folder:")
            _print_books([n for n in d["nearby"] if n["id"] != b["id"]])
    return _out(d, a.json)


def cmd_formats(a):
    res = queries.formats(root=a.root, shelf=a.shelf)
    if not a.json:
        print(f"{len(res['formats'])} formats")
        for f in res["formats"]:
            span = (f"{f['first_date']} - {f['last_date']}"
                    if f["first_date"] else "no dates")
            print(f"  {f['format']:<10} {f['n_books']:>6} books  "
                  f"{_gb(f['bytes']):>10}  {f['n_authors']:>5} authors  {span}")
    return _out(res, a.json)


def cmd_folders(a):
    res = queries.folders(root=a.root, shelf=a.shelf)
    if not a.json:
        print(f"{len(res['folders'])} folders")
        for f in res["folders"]:
            print(f"  {f['root_label']:<14} {f['shelf'] or '(flat)':<16} "
                  f"{f['folder'][:44]:<44} {f['n_books']:>3} books")
    return _out(res, a.json)


# -------------------------------------------------------------- reading
def cmd_reading(a):
    rows = reader.recent(limit=a.limit)
    if not a.json:
        print(f"{len(rows)} books in progress")
        for r in rows:
            pct = round((r["percent"] or 0) * 100)
            flag = "done" if r["finished"] else f"{pct:>3}%"
            print(f"  [{r['id']:>6}] {flag}  {(r['author'] or '?')[:20]:<20} "
                  f"{r['title'][:44]}")
    return _out(rows, a.json)


def cmd_book(a):
    d = reader.manifest(a.id)
    if not a.json:
        if d.get("error"):
            print(d["error"], file=sys.stderr)
            return None
        b = d["book"]
        print(f"[{b['author'] or '?'}] {b['title']}   ({d['kind']})")
        if d.get("detail"):
            print(f"  {d['detail']}")
        if d["kind"] == "images":
            print(f"  {len(d['pages'])} pages, {d['direction']}")
        elif d["kind"] == "ebook":
            print(f"  {b['size']:,} bytes -- opened and paginated in the browser")
        elif d["kind"] == "text":
            print(f"  {len(d['text']):,} characters, decoded as {d['encoding']}")
        p = d.get("progress")
        if p:
            print(f"  read {round((p['percent'] or 0) * 100)}%"
                  f"{' (finished)' if p['finished'] else ''}")
    return _out(d, a.json)


def cmd_delete(a):
    """Take books off the shelf. Files only move if asked."""
    ids = list(dict.fromkeys(a.ids))
    if a.file and not a.yes:
        print(f"this would move {len(ids)} file(s) to their root's _trash folder:")
        for book_id in ids[:10]:
            d = queries.book(book_id)
            print(f"  [{book_id}] {d['book']['path'] if d else '(no such book)'}")
        if len(ids) > 10:
            print(f"  … and {len(ids) - 10} more")
        print("re-run with --yes to go ahead")
        return None
    res = library.discard_many(ids) if a.file else library.forget_many(ids)
    if not a.json:
        where = "files moved to _trash" if a.file else "files left where they are"
        print(f"removed {res['done']} of {res['total']} book(s)  ({where})")
        for f in res["failures"]:
            print(f"  ! [{f['id']}] {f['reason']}")
        print("  restore with: lnlib trash, then lnlib restore <id> …")
    return _out(res, a.json)


def cmd_trash(a):
    if a.empty:
        if not a.yes:
            listing = library.trash(limit=1000)
            files = sum(1 for i in listing["items"]
                        if i["file_state"] == "trashed")
            print(f"{listing['total']} entries, of which {files} still hold a "
                  f"file that would be deleted for good")
            print("re-run with --yes to go ahead")
            return None
        res = library.empty(older_than_days=a.older_than)
        if not a.json:
            print(f"emptied {res['entries']} entries, "
                  f"{res['files_deleted']} files deleted, "
                  f"{res['files_kept']} left alone, {res['failed']} failed")
        return _out(res, a.json)

    res = library.trash(limit=a.limit)
    if not a.json:
        print(f"{res['total']} in the trash")
        for i in res["items"]:
            when = time.strftime("%Y-%m-%d %H:%M",
                                 time.localtime(i["trashed_at"]))
            print(f"  [{i['id']:>5}] {when}  {i['file_state']:<9} "
                  f"{i['format']:<7} {i['title'][:46]}")
    return _out(res, a.json)


def cmd_restore(a):
    res = library.restore_many(a.ids)
    if not a.json:
        print(f"restored {res['done']} of {res['total']}")
        for f in res["failures"]:
            print(f"  ! [{f['id']}] {f.get('title') or ''} {f['reason']}")
    return _out(res, a.json)


def cmd_config(a):
    """Inspect or edit roots.

    Removing a root also takes its books off the shelf -- it is never scanned
    again, so they would otherwise stay listed forever. Files and reading
    progress are not touched; adding the root back restores everything.
    """
    cfg = config.Config.load()
    changed = False
    # Said out loud only when the output is for a person; with --json the
    # roots themselves are the answer and nothing else belongs on stdout.
    say = (lambda *_: None) if a.json else print

    for raw in a.remove_root or []:
        target = os.path.normcase(os.path.abspath(raw))
        keep = [r for r in cfg.roots
                if os.path.normcase(os.path.abspath(r.path)) != target]
        if len(keep) == len(cfg.roots):
            say(f"not a root: {raw}")
            continue
        gone = [r for r in cfg.roots if r not in keep]
        cfg.roots = keep
        changed = True
        for r in gone:
            res = library.drop_root(r.path)
            say(f"removed root {r.path}  ({res['removed']} books off the shelf)")

    for raw in a.add_root or []:
        path = os.path.abspath(raw)
        if not os.path.isdir(path):
            say(f"not a folder: {path}")
            continue
        if any(os.path.normcase(r.path) == os.path.normcase(path) for r in cfg.roots):
            say(f"already a root: {path}")
            continue
        layout = a.layout or "shelves"
        cfg.roots.append(config.Root(
            path=path, label=a.label or os.path.basename(path.rstrip("\\/")),
            kind=a.kind or "novel", layout=layout))
        changed = True
        say(f"added root {path}  (layout: {layout})")

    if changed:
        cfg.save()
    else:
        for r in cfg.roots:
            mark = "" if os.path.isdir(r.path) else "   [MISSING]"
            say(f"  {'on ' if r.enabled else 'off'} {r.layout:<8} {r.kind:<8} "
                f"{r.label:<18} {r.path}{mark}")
    return _out([r.__dict__ for r in config.Config.load().roots], a.json)


def build_parser():
    p = argparse.ArgumentParser(prog="lnlib", description="light novel bookshelf and reader")
    p.add_argument("--json", action="store_true", help="machine readable output")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="rebuild the index from disk")
    s.set_defaults(fn=cmd_scan)

    s = sub.add_parser("serve", help="run the web UI")
    s.add_argument("--host"); s.add_argument("--port", type=int)
    s.add_argument("--no-browser", action="store_true")
    s.add_argument("--base-path", metavar="/prefix",
                   help="serve under a path prefix instead of the origin root, "
                        "for running behind a shared edge")
    s.set_defaults(fn=cmd_serve)

    s = sub.add_parser("covers", help="extract covers in bulk")
    s.add_argument("--limit", type=int, default=0)
    s.add_argument("--redo", action="store_true")
    s.set_defaults(fn=cmd_covers)

    s = sub.add_parser("overview", help="counts per shelf")
    s.set_defaults(fn=cmd_overview)

    s = sub.add_parser("books", help="list books")
    s.add_argument("--root"); s.add_argument("--shelf"); s.add_argument("--folder")
    s.add_argument("--q")
    s.add_argument("--format", metavar="epub[,pdf…]",
                   help="only these formats, comma separated")
    s.add_argument("--only",
                   choices=["undated", "extra", "absent", "present"])
    s.add_argument("--order", choices=sorted(queries.ORDERS), default=queries.DEFAULT_ORDER)
    s.add_argument("--offset", type=int, default=0)
    s.add_argument("--limit", type=int, default=100)
    s.set_defaults(fn=cmd_books)

    s = sub.add_parser("show", help="one book and what sits beside it")
    s.add_argument("id", type=int)
    s.set_defaults(fn=cmd_show)

    s = sub.add_parser("formats", help="what the collection is made of")
    s.add_argument("--root"); s.add_argument("--shelf")
    s.set_defaults(fn=cmd_formats)

    s = sub.add_parser("folders", help="content folders on the shelves")
    s.add_argument("--root"); s.add_argument("--shelf")
    s.set_defaults(fn=cmd_folders)

    s = sub.add_parser("reading", help="books with saved reading progress")
    s.add_argument("--limit", type=int, default=60)
    s.set_defaults(fn=cmd_reading)

    s = sub.add_parser("book", help="what the reader sees inside one volume")
    s.add_argument("id", type=int)
    s.set_defaults(fn=cmd_book)

    s = sub.add_parser("delete", help="take books off the shelf")
    s.add_argument("ids", type=int, nargs="+", metavar="ID")
    s.add_argument("--file", action="store_true",
                   help="move the file to its root's _trash folder too")
    s.add_argument("--yes", action="store_true", help="do not ask")
    s.set_defaults(fn=cmd_delete)

    s = sub.add_parser("trash", help="books taken off the shelf")
    s.add_argument("--limit", type=int, default=50)
    s.add_argument("--empty", action="store_true",
                   help="delete trashed files for good")
    s.add_argument("--older-than", type=float, metavar="DAYS",
                   help="with --empty, only entries older than this")
    s.add_argument("--yes", action="store_true", help="do not ask")
    s.set_defaults(fn=cmd_trash)

    s = sub.add_parser("restore", help="put trashed books back")
    s.add_argument("ids", type=int, nargs="+", metavar="ID",
                   help="trash ids, from `lnlib trash`")
    s.set_defaults(fn=cmd_restore)

    s = sub.add_parser("config", help="inspect or edit roots")
    s.add_argument("--add-root", action="append", metavar="PATH",
                   help="add a root; may be given more than once")
    s.add_argument("--remove-root", action="append", metavar="PATH",
                   help="remove a root and take its books off the shelf; "
                        "may be given more than once")
    s.add_argument("--label", help="shelf name for an added root "
                                   "(default: the folder's name)")
    s.add_argument("--kind")
    s.add_argument("--layout", choices=config.LAYOUTS,
                   help="shelves: folders under the root are shelves (default); "
                        "authors: folders under the root are authors, "
                        "as in a Calibre export")
    s.set_defaults(fn=cmd_config)

    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    db.init()
    args.fn(args)


if __name__ == "__main__":
    main()
