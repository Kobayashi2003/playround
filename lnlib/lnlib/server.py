"""Local HTTP server. Standard library only, bound to loopback by default.

Three families of route:

    /api/...       JSON, for the shelf views
    /cover/<id>    a cached cover image
    /book/<id>/... the inside of one book, served as a virtual directory so
                   the relative links of an epub resolve without rewriting
"""
from __future__ import annotations

import json
import mimetypes
import os
import posixpath
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import config, covers, db, queries, reader

WEB_DIR = os.path.join(config.PROJECT_DIR, "web")
_cover_lock = threading.Lock()

# Public path prefix the shelf answers under, "" at the origin root. Set by
# `serve --base-path`, because a shared edge (app-gateway) fronts several apps on
# one port and the root is not this one's to own there. Stripped once at the door,
# so all three route families below still see their own path shape either way.
BASE_PATH = ""


def _json_bytes(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "lnlib"

    def log_message(self, fmt, *args):        # keep the console usable
        return

    # ------------------------------------------------------------ plumbing
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        self._send(code, _json_bytes(obj), "application/json; charset=utf-8",
                   {"Cache-Control": "no-store"})

    def _err(self, code: int, msg: str):
        self._json({"error": msg}, code)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except ValueError:
            return {}

    # ---------------------------------------------------------------- mount
    def _redirect(self, location: str, code: int = 308):
        self.send_response(code)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _mount(self, path: str) -> str | None:
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
        self._err(404, "not found")
        return None

    # --------------------------------------------------------------- routes
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = self._mount(parsed.path)
        if path is None:
            return
        qs = urllib.parse.parse_qs(parsed.query)

        def one(k, default=None):
            v = qs.get(k)
            return v[0] if v else default

        try:
            if path.startswith("/api/"):
                return self._api_get(path, one, qs)
            if path.startswith("/cover/"):
                return self._cover(int(path.rsplit("/", 1)[-1]))
            if path.startswith("/book/"):
                return self._book(path, one("as"))
            return self._static(path)
        except BrokenPipeError:
            pass
        except ConnectionAbortedError:
            pass
        except Exception as e:                                     # noqa: BLE001
            self._err(500, f"{type(e).__name__}: {e}")

    def _api_get(self, path, one, qs):
        if path == "/api/overview":
            return self._json(queries.overview())
        if path == "/api/series":
            return self._json(queries.series_list(
                root=one("root"), shelf=one("shelf"), q=one("q"), only=one("only"),
                offset=int(one("offset", 0)), limit=min(int(one("limit", 120)), 500)))
        if path.startswith("/api/series/"):
            d = queries.series_detail(int(path.rsplit("/", 1)[-1]))
            return self._json(d) if d else self._err(404, "no such series")
        if path == "/api/missing":
            return self._json(queries.missing(root=one("root")))
        if path == "/api/reading":
            return self._json({"items": reader.recent(
                limit=min(int(one("limit", 60)), 200))})
        if path.startswith("/api/book/"):
            d = reader.manifest(int(path.rsplit("/", 1)[-1]))
            return self._err(404, d["error"]) if d.get("error") else self._json(d)
        if path == "/api/config":
            cfg = config.Config.load()
            return self._json({"roots": [r.__dict__ for r in cfg.roots],
                               "theme": cfg.theme})
        return self._err(404, "unknown endpoint")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = self._mount(parsed.path)
        if path is None:
            return
        body = self._body()
        try:
            if path == "/api/scan":
                from . import scan as scanner
                return self._json(scanner.scan(verbose=False))
            if path == "/api/covers/build":
                from . import coverjob
                return self._json(coverjob.build(limit=int(body.get("limit", 400)),
                                                 redo=bool(body.get("redo"))))
            if path == "/api/progress":
                if body.get("clear"):
                    return self._json(reader.clear_progress(int(body["item_id"])))
                return self._json(reader.save_progress(
                    int(body["item_id"]), body.get("locator"),
                    float(body.get("position") or 0), float(body.get("percent") or 0),
                    bool(body.get("finished"))))
            if path == "/api/open":
                target = body.get("path") or ""
                if not os.path.exists(target):
                    return self._err(404, "path not found")
                os.startfile(target)
                return self._json({"ok": True})
            if path == "/api/reveal":
                target = body.get("path") or ""
                if not os.path.exists(target):
                    return self._err(404, "path not found")
                os.startfile(os.path.dirname(target) if os.path.isfile(target) else target)
                return self._json({"ok": True})
            return self._err(404, "unknown endpoint")
        except KeyError as e:
            self._err(400, f"missing field {e}")
        except Exception as e:                                     # noqa: BLE001
            self._err(500, f"{type(e).__name__}: {e}")

    # ---------------------------------------------------------------- books
    def _book(self, path: str, as_: str | None = None):
        """/book/<id>/raw  or  /book/<id>/f/<path inside the book>

        `?as=html` re-serves an XHTML page as text/html. The front end asks for
        that only after the strict XML parser has already rejected the file --
        a handful of shop-generated epubs are not well-formed, and the reader
        should show them anyway.
        """
        rest = path[len("/book/"):]
        head, _, tail = rest.partition("/")
        try:
            item_id = int(head)
        except ValueError:
            return self._err(400, "bad book id")

        cache = {"Cache-Control": "private, max-age=3600"}
        try:
            if tail == "raw":
                full, mime = reader.whole_file(item_id)
                with open(full, "rb") as fh:
                    return self._send(200, fh.read(), mime, cache)
            if tail.startswith("f/"):
                data, mime = reader.resource(item_id, tail[2:])
                if as_ == "html" and ("xhtml" in mime or "xml" in mime):
                    mime = "text/html; charset=utf-8"
                return self._send(200, data, mime, cache)
        except KeyError as e:
            return self._err(404, str(e))
        except FileNotFoundError as e:
            return self._err(404, f"not in this book: {e}")
        except OSError as e:
            return self._err(500, str(e))
        return self._err(404, "unknown book route")

    # --------------------------------------------------------------- covers
    def _cover(self, item_id: int):
        with db.connect() as conn:
            row = conn.execute(
                "SELECT i.path,i.ext,i.is_dir,i.is_missing,c.cache_name,c.mime,c.state "
                "FROM items i LEFT JOIN covers c ON c.item_id=i.id WHERE i.id=?",
                (item_id,)).fetchone()
        if not row:
            return self._err(404, "no such item")
        if row["is_missing"]:
            return self._err(404, "placeholder has no cover")

        cache_name, mime, state = row["cache_name"], row["mime"], row["state"]
        if state != "ok" or not cache_name or not os.path.exists(
                os.path.join(config.CACHE_DIR, cache_name)):
            if state == "error":
                return self._err(404, "cover extraction failed")
            with _cover_lock:
                res = covers.extract(row["path"], row["ext"], bool(row["is_dir"]))
                with db.connect() as conn:
                    conn.execute(
                        "INSERT INTO covers(item_id,cache_name,mime,source,state,detail,"
                        "updated_at) VALUES(?,?,?,?,?,?,?) "
                        "ON CONFLICT(item_id) DO UPDATE SET cache_name=excluded.cache_name,"
                        "mime=excluded.mime,source=excluded.source,state=excluded.state,"
                        "detail=excluded.detail,updated_at=excluded.updated_at",
                        (item_id, res["cache_name"], res["mime"], res["source"],
                         res["state"], res["detail"], db.now()))
            if res["state"] != "ok":
                return self._err(404, res["detail"] or "no cover")
            cache_name, mime = res["cache_name"], res["mime"]

        full = os.path.join(config.CACHE_DIR, cache_name)
        try:
            with open(full, "rb") as fh:
                data = fh.read()
        except OSError:
            return self._err(404, "cover missing from cache")
        self._send(200, data, mime or "image/jpeg",
                   {"Cache-Control": "public, max-age=604800"})

    # --------------------------------------------------------------- static
    def _static(self, path: str):
        if path in ("/", ""):
            path = "/index.html"
        rel = posixpath.normpath(path).lstrip("/")
        if rel.startswith("..") or os.path.isabs(rel):
            return self._err(403, "forbidden")
        full = os.path.join(WEB_DIR, rel.replace("/", os.sep))
        if not os.path.isfile(full):
            return self._err(404, "not found")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        with open(full, "rb") as fh:
            data = fh.read()
        self._send(200, data, ctype, {"Cache-Control": "no-cache"})


def serve(host: str | None = None, port: int | None = None, open_browser: bool = True,
          base_path: str | None = None):
    global BASE_PATH
    cfg = config.Config.load()
    db.init()
    host = host or cfg.host
    port = port or cfg.port
    prefix = (base_path if base_path is not None else cfg.base_path).strip("/")
    BASE_PATH = "/" + prefix if prefix else ""
    httpd = ThreadingHTTPServer((host, port), Handler)
    url = f"http://{host}:{port}{BASE_PATH}/"
    print(f"lnlib serving on {url}   (ctrl-c to stop)")
    if open_browser:
        import webbrowser
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        httpd.server_close()
