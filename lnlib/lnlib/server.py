"""Local HTTP server. Standard library only, bound to loopback by default.

Three families of route:

    /api/...       JSON, for the shelf views
    /cover/<id>    a cached cover image
    /book/<id>/... one book: `raw` is the file itself, which is how an epub
                   reaches the reader in the browser, and `f/<path>` is one
                   file from inside it

Everything that changes the index is a POST under /api/, and the ones that
remove a book take an explicit `file` field: the shelf never decides on its
own whether deleting a record should also delete what it points at.

Everything else is the front end, served out of `web/dist` -- a built React
bundle. `npm run build` in `web/` produces it; when it is missing the server
says so rather than 404ing every asset in silence.
"""
from __future__ import annotations

import json
import mimetypes
import os
import posixpath
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import config, covers, db, library, queries, reader

WEB_DIR = os.path.join(config.PROJECT_DIR, "web", "dist")
WEB_SRC = os.path.join(config.PROJECT_DIR, "web")
_cover_lock = threading.Lock()

# Public path prefix the shelf answers under, "" at the origin root. Set by
# `serve --base-path`, because a shared edge (app-gateway) fronts several apps on
# one port and the root is not this one's to own there. Stripped once at the door,
# so all three route families below still see their own path shape either way.
BASE_PATH = ""

NO_BUILD_PAGE = b"""<!doctype html><meta charset="utf-8">
<title>lnlib</title>
<body style="font:14px/1.7 system-ui;margin:60px auto;max-width:44em;padding:0 1em">
<h1>The front end is not built yet</h1>
<p>The shelf is a React application now, so it has to be compiled before it can
be served:</p>
<pre style="background:#f4f4f2;padding:12px 14px;border-radius:8px">cd web
npm install
npm run build</pre>
<p>Then reload this page. While working on the interface, <code>npm run dev</code>
serves it with hot reloading and forwards the API to this process.</p>
<p>The API itself is running: <a href="api/overview">api/overview</a>.</p>
"""


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

    def _stream(self, path: str, ctype: str, extra: dict | None = None):
        """Send a file without reading it into memory first.

        An epub is handed over whole now, and a book of scans can be hundreds of
        megabytes; buffering those in a dict comprehension was fine when only
        one XHTML page at a time crossed the wire and is not fine now.
        """
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as fh:
            while True:
                chunk = fh.read(256 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)

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

    @staticmethod
    def _window(one, default: int, cap: int) -> tuple[int, int]:
        """`limit` and `offset` from the query string, clamped.

        Both are clamped at the bottom as well as the top: SQLite reads a
        negative LIMIT as "no limit at all", so a mistyped parameter would
        quietly turn a page request into the whole table.
        """
        def number(key, fallback):
            try:
                return int(one(key, fallback))
            except (TypeError, ValueError):
                return fallback
        return (max(1, min(number("limit", default), cap)),
                max(0, number("offset", 0)))

    def _api_get(self, path, one, qs):
        if path == "/api/overview":
            return self._json(queries.overview())
        if path == "/api/books":
            limit, offset = self._window(one, 120, 500)
            return self._json(queries.books(
                root=one("root"), shelf=one("shelf"), folder=one("folder"),
                q=one("q"), only=one("only"), fmt=one("format"),
                order=one("order"), offset=offset, limit=limit))
        if path == "/api/folders":
            return self._json(queries.folders(root=one("root"), shelf=one("shelf")))
        if path == "/api/formats":
            return self._json(queries.formats(root=one("root"), shelf=one("shelf")))
        if path == "/api/trash":
            limit, offset = self._window(one, 200, 1000)
            return self._json(library.trash(limit=limit, offset=offset))
        if path == "/api/reading":
            limit, _ = self._window(one, 60, 200)
            return self._json({"books": reader.recent(limit=limit)})
        if path.startswith("/api/books/"):
            d = queries.book(int(path.rsplit("/", 1)[-1]))
            return self._json(d) if d else self._err(404, "no such book")
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
                    return self._json(reader.clear_progress(int(body["book_id"])))
                return self._json(reader.save_progress(
                    int(body["book_id"]), body.get("locator"),
                    float(body.get("position") or 0), float(body.get("percent") or 0),
                    bool(body.get("finished"))))
            if path == "/api/books/delete":
                # `file` says what happens to the file itself, and nothing
                # is assumed: the caller has to say "trash" out loud.
                book_id = int(body["book_id"])
                if body.get("file") == "trash":
                    return self._json(library.discard(book_id))
                return self._json(library.forget(book_id))
            if path == "/api/trash/restore":
                return self._json(library.restore(int(body["trash_id"])))
            if path == "/api/trash/empty":
                return self._json(library.empty(
                    trash_id=(int(body["trash_id"])
                              if body.get("trash_id") is not None else None),
                    older_than_days=body.get("older_than_days")))
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

        `raw` is the whole file: an epub going to the reader, a PDF going to the
        browser's own viewer. `f/…` is one file from inside a zip or a folder of
        scans, which is how a page image is fetched.
        """
        rest = path[len("/book/"):]
        head, _, tail = rest.partition("/")
        try:
            book_id = int(head)
        except ValueError:
            return self._err(400, "bad book id")

        cache = {"Cache-Control": "private, max-age=3600"}
        try:
            if tail == "raw":
                full, mime = reader.whole_file(book_id)
                return self._stream(full, mime, cache)
            if tail.startswith("f/"):
                data, mime = reader.resource(book_id, tail[2:])
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
    def _cover(self, book_id: int):
        with db.connect() as conn:
            row = conn.execute(
                "SELECT b.path,b.ext,b.is_dir,b.format,c.cache_name,c.mime,c.state "
                "FROM books b LEFT JOIN covers c ON c.book_id=b.id WHERE b.id=?",
                (book_id,)).fetchone()
        if not row:
            return self._err(404, "no such book")
        if row["format"] == "txt":
            return self._err(404, "a text file has no cover")

        cache_name, mime, state = row["cache_name"], row["mime"], row["state"]
        if state != "ok" or not cache_name or not os.path.exists(
                os.path.join(config.CACHE_DIR, cache_name)):
            if state == "error":
                return self._err(404, "cover extraction failed")
            with _cover_lock:
                res = covers.extract(row["path"], row["ext"], bool(row["is_dir"]))
                with db.connect() as conn:
                    conn.execute(
                        "INSERT INTO covers(book_id,cache_name,mime,source,state,detail,"
                        "updated_at) VALUES(?,?,?,?,?,?,?) "
                        "ON CONFLICT(book_id) DO UPDATE SET cache_name=excluded.cache_name,"
                        "mime=excluded.mime,source=excluded.source,state=excluded.state,"
                        "detail=excluded.detail,updated_at=excluded.updated_at",
                        (book_id, res["cache_name"], res["mime"], res["source"],
                         res["state"], res["detail"], db.now()))
            if res["state"] != "ok":
                return self._err(404, res["detail"] or "no cover")
            cache_name, mime = res["cache_name"], res["mime"]

        full = os.path.join(config.CACHE_DIR, cache_name)
        if not os.path.isfile(full):
            return self._err(404, "cover missing from cache")
        self._stream(full, mime or "image/jpeg",
                     {"Cache-Control": "public, max-age=604800"})

    # --------------------------------------------------------------- static
    def _static(self, path: str):
        """The built front end.

        Assets are content-hashed by the bundler, so they are cached hard and
        the entry document is not cached at all. Any path that is not a file is
        the entry document: routing happens in the browser.
        """
        if not os.path.isdir(WEB_DIR):
            return self._send(200, NO_BUILD_PAGE, "text/html; charset=utf-8",
                              {"Cache-Control": "no-store"})
        rel = posixpath.normpath(path).lstrip("/")
        if rel.startswith("..") or os.path.isabs(rel):
            return self._err(403, "forbidden")
        full = os.path.join(WEB_DIR, rel.replace("/", os.sep))
        hashed = rel.startswith("assets/")
        if not rel or not os.path.isfile(full):
            full, hashed = os.path.join(WEB_DIR, "index.html"), False
        if not os.path.isfile(full):
            return self._err(404, "not found")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        self._stream(full, ctype, {"Cache-Control":
                                   "public, max-age=31536000, immutable" if hashed
                                   else "no-cache"})


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
    if not os.path.isdir(WEB_DIR):
        print(f"  ! the front end is not built -- run `npm install && npm run build` "
              f"in {WEB_SRC}")
    if open_browser:
        import webbrowser
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        httpd.server_close()
