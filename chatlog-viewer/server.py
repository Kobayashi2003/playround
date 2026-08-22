#!/usr/bin/env python3
"""chatlog-viewer — browse Claude Code / Codex conversation logs.

Usage:
    python server.py            # start and open a browser
    python server.py --port 8777 --no-open
    python server.py --reindex  # drop the cache and re-parse everything
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import threading
import time
import traceback
import urllib.parse
import webbrowser
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# The Windows console is often not UTF-8; switch the streams over first.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

sys.path.insert(0, str(Path(__file__).resolve().parent))
import parsers  # noqa: E402

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

CACHE_FILE = ROOT / ".cache" / "index.json"
CACHE_VERSION = 4

# User-authored state (stars, notes, renames). Held outside .cache because, unlike
# the index, it cannot be regenerated; indexing never writes to it.
STORE_FILE = ROOT / "store.json"
STORE_VERSION = 1
TRASH_DIR = ROOT / ".trash"

SEARCH_BUDGET = 30000  # chars of user text kept per session for search

# Public path prefix the viewer answers under, "" at the origin root. Set by
# --base-path, because a shared edge (app-gateway) fronts several apps on one
# port and the root is not this one's to own there. Stripped once at the door, so
# every route below still sees its own path shape either way.
BASE_PATH = ""


# ------------------------------------------------------------------- indexing

def summarize(path, source, stat, parsed=None):
    parsed = parsed or parsers.parse(path, source)
    meta, turns = parsed["meta"], parsed["turns"]

    stamps = [t["ts"] for t in turns if t.get("ts")]
    user_texts = [t["text"] for t in turns if t["role"] == "user" and t.get("text")]
    counts = {}
    for t in turns:
        counts[t["role"]] = counts.get(t["role"], 0) + 1

    first_user = next((t for t in user_texts if t.strip()), "")
    title = meta.get("title") or re.sub(r"\s+", " ", first_user).strip()[:90]

    haystack = "\n".join(user_texts)
    return {
        "id": meta["id"],
        "source": source,
        "path": str(path),
        "mtime": stat.st_mtime,
        "size": stat.st_size,
        "cwd": meta.get("cwd") or "",
        "branch": meta.get("branch") or "",
        "version": meta.get("version") or "",
        "model": meta.get("model") or "",
        "title": title or "(untitled)",
        "preview": re.sub(r"\s+", " ", first_user).strip()[:240],
        "started": min(stamps) if stamps else "",
        "ended": max(stamps) if stamps else "",
        "n_user": counts.get("user", 0),
        "n_assistant": counts.get("assistant", 0),
        "n_tool": counts.get("tool_use", 0),
        "n_turns": len(turns),
        "search": haystack[:SEARCH_BUDGET],
    }


class Store:
    """Per-session flags set by the user: star, archive, rename, note.

    Stored in a JSON file keyed by log path. Log files are never modified; this is
    the only state the viewer writes.
    """

    FIELDS = ("star", "archived", "title", "note")

    def __init__(self):
        self.items = {}
        self.lock = threading.Lock()
        self.load()

    def load(self):
        try:
            data = json.loads(STORE_FILE.read_text(encoding="utf-8"))
            if data.get("version") == STORE_VERSION:
                self.items = data.get("items") or {}
        except Exception:
            self.items = {}

    def save(self):
        tmp = STORE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({"version": STORE_VERSION, "items": self.items},
                                  ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(STORE_FILE)

    def get(self, path):
        return self.items.get(path) or {}

    def patch(self, path, patch):
        with self.lock:
            item = dict(self.items.get(path) or {})
            for k in self.FIELDS:
                if k not in patch:
                    continue
                v = patch[k]
                if v in (None, "", False):
                    item.pop(k, None)
                else:
                    item[k] = v
            if item:
                self.items[path] = item
            else:
                self.items.pop(path, None)
            self.save()
            return item

    def forget(self, path):
        with self.lock:
            if self.items.pop(path, None) is not None:
                self.save()


STORE = Store()


class Index:
    def __init__(self):
        self.entries = {}          # path -> entry
        self.lock = threading.Lock()
        self.status = {"state": "idle", "done": 0, "total": 0}

    def load_cache(self):
        try:
            data = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
            if data.get("version") == CACHE_VERSION:
                self.entries = {e["path"]: e for e in data["entries"]}
                print("[index] loaded %d sessions from cache" % len(self.entries))
        except Exception:
            self.entries = {}

    def save_cache(self):
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({"version": CACHE_VERSION,
                                   "entries": list(self.entries.values())},
                                  ensure_ascii=False), encoding="utf-8")
        tmp.replace(CACHE_FILE)

    def refresh(self, force=False):
        found = parsers.discover()
        with self.lock:
            self.status = {"state": "indexing", "done": 0, "total": len(found)}
        alive, changed = set(), 0
        for i, (path, source) in enumerate(found):
            key = str(path)
            alive.add(key)
            try:
                st = path.stat()
            except OSError:
                continue
            old = self.entries.get(key)
            if not force and old and old["mtime"] == st.st_mtime and old["size"] == st.st_size:
                self.status["done"] = i + 1
                continue
            try:
                self.entries[key] = summarize(path, source, st)
                changed += 1
            except Exception:
                print("[index] failed to parse %s" % path)
                traceback.print_exc()
            self.status["done"] = i + 1
        for gone in set(self.entries) - alive:
            del self.entries[gone]
        with self.lock:
            self.status = {"state": "ready", "done": len(found), "total": len(found)}
        self.save_cache()
        print("[index] done: %d sessions (%d newly parsed)" % (len(self.entries), changed))

    @staticmethod
    def public(entry):
        """Index entry as returned to the client: search text removed, user flags merged."""
        item = {k: v for k, v in entry.items() if k != "search"}
        flags = STORE.get(entry["path"])
        item["star"] = bool(flags.get("star"))
        item["archived"] = bool(flags.get("archived"))
        item["note"] = flags.get("note") or ""
        if flags.get("title"):
            item["title_auto"] = item["title"]
            item["title"] = flags["title"]
        return item

    def list(self):
        out = [self.public(e) for e in self.entries.values()]
        out.sort(key=lambda e: e["started"] or "", reverse=True)
        return out

    def drop(self, path):
        self.entries.pop(path, None)
        self.save_cache()

    def search(self, query, limit=400):
        q = query.lower().strip()
        if not q:
            return []
        hits = []
        for e in self.entries.values():
            hay = e.get("search", "")
            low = hay.lower()
            pos = low.find(q)
            if pos < 0:
                continue
            snippets, start = [], 0
            while pos >= 0 and len(snippets) < 4:
                a, b = max(0, pos - 24), min(len(hay), pos + len(q) + 120)
                snippets.append(("…" if a else "") + hay[a:b].replace("\n", " ") + ("…" if b < len(hay) else ""))
                start = pos + len(q)
                pos = low.find(q, start)
            item = self.public(e)
            item["snippets"] = snippets
            item["hits"] = low.count(q)
            hits.append(item)
        hits.sort(key=lambda e: e["started"] or "", reverse=True)
        return hits[:limit]


INDEX = Index()


# --------------------------------------------------------------------- server

class Handler(BaseHTTPRequestHandler):
    server_version = "chatlog-viewer"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError):
            pass

    def _redirect(self, location, code=308):
        self.send_response(code)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _mount(self, path):
        """Strip BASE_PATH, or answer the request here and return None.

        The bare prefix redirects to the trailing-slash form: index.html links its
        assets relatively and a browser resolves those against the document's
        directory, which is the mount point only when the URL ends in a slash.
        """
        if not BASE_PATH:
            return path
        if path == BASE_PATH:
            self._redirect(BASE_PATH + "/")
            return None
        if path.startswith(BASE_PATH + "/"):
            return path[len(BASE_PATH):]
        self._send(404, "not found", "text/plain; charset=utf-8")
        return None

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        path = self._mount(u.path)
        if path is None:
            return
        q = urllib.parse.parse_qs(u.query)
        try:
            if path == "/api/sessions":
                return self._send(200, {"sessions": INDEX.list(), "status": INDEX.status})
            if path == "/api/status":
                return self._send(200, INDEX.status)
            if path == "/api/search":
                return self._send(200, {"results": INDEX.search(q.get("q", [""])[0])})
            if path == "/api/session":
                return self._session(q)
            if path == "/api/peek":
                return self._peek(q)
            if path == "/api/reindex":
                threading.Thread(target=INDEX.refresh, daemon=True).start()
                return self._send(200, {"ok": True})
            return self._static(path)
        except Exception as exc:
            traceback.print_exc()
            return self._send(500, {"error": str(exc)})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        path = self._mount(u.path)
        if path is None:
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if path == "/api/manage":
                return self._manage(body)
            if path == "/api/delete":
                return self._delete(body)
            return self._send(404, {"error": "unknown endpoint"})
        except Exception as exc:
            traceback.print_exc()
            return self._send(500, {"error": str(exc)})

    def _manage(self, body):
        path = body.get("path") or ""
        if path not in INDEX.entries:
            return self._send(404, {"error": "unknown session"})
        STORE.patch(path, body.get("patch") or {})
        return self._send(200, {"session": INDEX.public(INDEX.entries[path])})

    def _delete(self, body):
        """Move a log into .trash/. The file is relocated, not deleted."""
        path = body.get("path") or ""
        entry = INDEX.entries.get(path)
        if not entry:
            return self._send(404, {"error": "unknown session"})
        src = Path(path)
        TRASH_DIR.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = TRASH_DIR / ("%s-%s-%s" % (stamp, entry["source"], src.name))
        try:
            # shutil.move, not Path.replace: the logs are under C:\Users while the
            # viewer may be on another drive, and rename() cannot cross volumes.
            shutil.move(str(src), str(dest))
        except OSError as exc:
            return self._send(500, {"error": "move failed: %s" % exc})
        STORE.forget(path)
        INDEX.drop(path)
        return self._send(200, {"ok": True, "trash": str(dest)})

    def _peek(self, q):
        """Cheap change check for the open session: stat only, no parsing."""
        path = q.get("path", [""])[0]
        if path not in INDEX.entries:
            return self._send(404, {"error": "unknown session"})
        try:
            st = Path(path).stat()
        except OSError as exc:
            return self._send(404, {"error": str(exc)})
        return self._send(200, {"mtime": st.st_mtime, "size": st.st_size})

    def _session(self, q):
        path = q.get("path", [""])[0]
        entry = INDEX.entries.get(path)
        if not entry:
            return self._send(404, {"error": "unknown session"})
        parsed = parsers.parse(Path(path), entry["source"])
        # A session that is still being written outgrows its index entry. Refresh the
        # entry from the parse just done, so the header and sidebar counts stay right.
        try:
            st = Path(path).stat()
        except OSError:
            st = None
        if st and (st.st_mtime != entry["mtime"] or st.st_size != entry["size"]):
            entry = summarize(Path(path), entry["source"], st, parsed)
            INDEX.entries[path] = entry
            INDEX.save_cache()
        return self._send(200, {"meta": INDEX.public(entry), "turns": parsed["turns"]})

    def _static(self, path):
        name = "index.html" if path == "/" else path.lstrip("/")
        target = (STATIC / name).resolve()
        if not str(target).startswith(str(STATIC.resolve())) or not target.is_file():
            return self._send(404, "not found", "text/plain; charset=utf-8")
        ctype = {".html": "text/html; charset=utf-8",
                 ".css": "text/css; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8"}.get(target.suffix, "application/octet-stream")
        self._send(200, target.read_bytes(), ctype)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--base-path", default="", metavar="/prefix",
                    help="serve under a path prefix instead of the origin root, "
                         "for running behind a shared edge")
    ap.add_argument("--reindex", action="store_true")
    args = ap.parse_args()

    global BASE_PATH
    prefix = args.base_path.strip("/")
    BASE_PATH = "/" + prefix if prefix else ""

    if not args.reindex:
        INDEX.load_cache()
    print("[index] scanning logs… (the first run can take a minute)")
    threading.Thread(target=lambda: INDEX.refresh(force=args.reindex), daemon=True).start()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = "http://%s:%d%s/" % (args.host, args.port, BASE_PATH)
    print("chatlog-viewer is up → %s   (Ctrl+C to quit)" % url)
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nBye.")


if __name__ == "__main__":
    main()
