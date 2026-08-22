"""Command line interface. Every command prints JSON when given --json.

The web UI is the place to actually read a book; these commands exist to build
and inspect the index without opening a browser.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from . import config, coverjob, db, queries, reader
from . import scan as scanner


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
        print(f"{t.get('n_series',0)} series / {t.get('n_items',0)} items / "
              f"{t.get('n_missing',0)} missing / {t.get('n_undated',0)} undated")
        for s in ov["shelves"]:
            print(f"  {s['root_label']:<14} {s['shelf'] or '(flat)':<18} "
                  f"series={s['n_series']:<5} items={s['n_items']:<6} "
                  f"missing={s['n_missing']:<5} undated={s['n_undated']}")
    return _out(ov, a.json)


def cmd_series(a):
    res = queries.series_list(root=a.root, shelf=a.shelf, q=a.q, only=a.only,
                              offset=a.offset, limit=a.limit)
    if not a.json:
        print(f"{res['total']} series")
        for s in res["series"]:
            flag = []
            if s["n_missing"]:
                flag.append(f"missing={s['n_missing']}")
            if s["n_undated"]:
                flag.append(f"undated={s['n_undated']}")
            print(f"  [{s['id']:>5}] [{s['author'] or '?'}] {s['title'][:52]:<52} "
                  f"{s['n_items']:>3} items  {' '.join(flag)}")
    return _out(res, a.json)


def cmd_show(a):
    d = queries.series_detail(a.id)
    if not d:
        print("no such series", file=sys.stderr)
        return None
    if not a.json:
        s = d["series"]
        print(f"[{s['author']}] {s['title']}")
        print(f"  {s['root_label']} / {s['shelf']}   key={s['series_key']}")
        print(f"  {s['path']}")
        for i in d["items"]:
            mark = "MISSING" if i["is_missing"] else ("extra" if i["is_extra"] else "")
            pct = i.get("read_percent")
            read = f"{round(pct * 100)}%" if pct else ""
            print(f"    [{i['id']:>6}] {i['date'] or '        '}  "
                  f"v{i['volume'] or '-':<5} {i['title'][:52]:<52} {mark} {read}")
    return _out(d, a.json)


def cmd_missing(a):
    res = queries.missing(root=a.root)
    if not a.json:
        print(f"{res['count']} missing volumes in {len(res['groups'])} series")
        for g in res["groups"]:
            print(f"  [{g['author']}] {g['title'][:50]}")
            for i in g["items"]:
                print(f"      {i['date'] or '        '}  {i['title'][:60]}")
    return _out(res, a.json)


# -------------------------------------------------------------- reading
def cmd_reading(a):
    rows = reader.recent(limit=a.limit)
    if not a.json:
        print(f"{len(rows)} books in progress")
        for r in rows:
            pct = round((r["percent"] or 0) * 100)
            flag = "done" if r["finished"] else f"{pct:>3}%"
            print(f"  [{r['item_id']:>6}] {flag}  {r['series_title'][:34]:<34} "
                  f"{r['title'][:40]}")
    return _out(rows, a.json)


def cmd_book(a):
    d = reader.manifest(a.id)
    if not a.json:
        if d.get("error"):
            print(d["error"], file=sys.stderr)
            return None
        it = d["item"]
        print(f"[{it['author'] or '?'}] {it['title']}   ({d['kind']})")
        if d.get("detail"):
            print(f"  {d['detail']}")
        if d["kind"] == "epub":
            m = d["meta"]
            print(f"  {m['direction']} / {m['layout']} / {len(d['sections'])} sections"
                  f" / {len(d['toc'])} toc entries")
            for t in d["toc"][:40]:
                print("    " + "  " * t["depth"] + t["label"][:60])
        elif d["kind"] == "images":
            print(f"  {len(d['pages'])} pages")
    return _out(d, a.json)


def cmd_config(a):
    cfg = config.Config.load()
    if a.add_root:
        path = os.path.abspath(a.add_root)
        if any(os.path.normcase(r.path) == os.path.normcase(path) for r in cfg.roots):
            print("root already present")
        else:
            cfg.roots.append(config.Root(path=path, label=a.label or os.path.basename(path),
                                         kind=a.kind or "novel"))
            cfg.save()
            print(f"added root {path}")
    elif a.remove_root:
        before = len(cfg.roots)
        cfg.roots = [r for r in cfg.roots
                     if os.path.normcase(r.path) != os.path.normcase(a.remove_root)]
        cfg.save()
        print(f"removed {before - len(cfg.roots)} root(s)")
    else:
        for r in cfg.roots:
            mark = "" if os.path.isdir(r.path) else "   [MISSING]"
            print(f"  {'on ' if r.enabled else 'off'} {r.kind:<8} {r.label:<16} "
                  f"{r.path}{mark}")
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

    s = sub.add_parser("series", help="list series")
    s.add_argument("--root"); s.add_argument("--shelf"); s.add_argument("--q")
    s.add_argument("--only", choices=["missing", "undated"])
    s.add_argument("--offset", type=int, default=0)
    s.add_argument("--limit", type=int, default=100)
    s.set_defaults(fn=cmd_series)

    s = sub.add_parser("show", help="one series with its volumes")
    s.add_argument("id", type=int)
    s.set_defaults(fn=cmd_show)

    s = sub.add_parser("missing", help="all placeholder volumes")
    s.add_argument("--root")
    s.set_defaults(fn=cmd_missing)

    s = sub.add_parser("reading", help="books with saved reading progress")
    s.add_argument("--limit", type=int, default=60)
    s.set_defaults(fn=cmd_reading)

    s = sub.add_parser("book", help="what the reader sees inside one volume")
    s.add_argument("id", type=int)
    s.set_defaults(fn=cmd_book)

    s = sub.add_parser("config", help="inspect or edit roots")
    s.add_argument("--add-root"); s.add_argument("--remove-root")
    s.add_argument("--label"); s.add_argument("--kind")
    s.set_defaults(fn=cmd_config)

    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    db.init()
    args.fn(args)


if __name__ == "__main__":
    main()
