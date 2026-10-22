# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Collection Tree: a single-file, standard-library Everything HTTP / filesystem viewer.

Run: python collection_tree.py  (build, start the local service, open the browser)
Build only: python collection_tree.py --build
Serve existing pages: python collection_tree.py --serve
Create configuration: python collection_tree.py --init-config settings.json
Use configuration: python collection_tree.py --config settings.json

Only indexes and generated files are changed. Collection files are read-only. See --help.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import datetime as dt
import fnmatch
import hashlib
import html
import json
import os
from functools import lru_cache
from pathlib import Path
import re
import secrets
import subprocess
import sys
import threading
import traceback
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


# Edit these defaults, or override them with --config JSON / command-line options.
DEFAULT_CONFIG = {
    "roots": [
        r"I:\コレクション - ギャルゲー - 部分整理",
        r"I:\コレクション - ギャルゲー - 完全整理",
    ],
    "targets": ["*/2. *", "*/3. *", "*/4. *", "*/5. *"],
    "exclude": [r"I:\コレクション - ギャルゲー - 完全整理\Lose"],
    "backend": "everything",
    "everything_url": "http://127.0.0.1:8081",
    "everything_username": "",
    "everything_password": "",
    "output": "HTML",
    "port": 16040,
    "workers": 4,
    "page_size": 10000,
    "timeout": 60,
}
SCRIPT = Path(__file__).resolve()
MARKER = "collection-tree-index"
MAX_BODY = 8192


def stamp() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def key(path: str | Path) -> str:
    return os.path.normcase(os.path.abspath(path))


def natural(name: str) -> list:
    """Sort key that orders embedded numbers numerically: 2 before 10."""
    return [(0, int(t), t) if t[0] in "0123456789" else (1, 0, t) for t in re.split(r"([0-9]+)", name.casefold()) if t]


def glob_match(candidate: str, pattern: str) -> bool:
    """A path wildcard * stays in its segment; ** spans zero or more segments."""
    parts = candidate.casefold().split("/")
    patterns = pattern.casefold().split("/")

    @lru_cache(None)
    def match(i: int, j: int) -> bool:
        if j == len(patterns):
            return i == len(parts)
        if patterns[j] == "**":
            return match(i, j + 1) or (i < len(parts) and match(i + 1, j))
        return i < len(parts) and fnmatch.fnmatchcase(parts[i], patterns[j]) and match(i + 1, j + 1)
    return match(0, 0)


def inside(path: str | Path, root: str | Path) -> bool:
    p, r = key(path), key(root)
    return p == r or p.startswith(r.rstrip(os.sep) + os.sep)


def atomic_write(path: Path, text: str) -> None:
    temp = path.with_name(path.name + "." + secrets.token_hex(4) + ".tmp")
    try:
        temp.write_text(text, encoding="utf-8")
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def js_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def index_order(item: dict) -> tuple:
    return item["title"].split(" - ")[0].casefold(), " - " in item["title"], item["title"].casefold()


def command(config: dict) -> str:
    args = [sys.executable, str(SCRIPT), "--serve", "--output", str(config["output"]), "--port", str(config["port"])]
    # Rebuilds in this service use this exact saved configuration.
    args += ["--config", str(Path(config["output"]) / "build-config.json")]
    return subprocess.list2cmdline(args)


def load_config(args: argparse.Namespace) -> dict:
    config = dict(DEFAULT_CONFIG)
    base = SCRIPT.parent
    if args.config:
        source = Path(args.config).resolve()
        loaded = json.loads(source.read_text(encoding="utf-8-sig"))
        if not isinstance(loaded, dict):
            raise ValueError("Configuration must be a JSON object")
        unknown = set(loaded) - set(DEFAULT_CONFIG)
        if unknown:
            raise ValueError("Unknown configuration fields: " + ", ".join(sorted(unknown)))
        config.update(loaded)
        base = source.parent
    for arg, field in [("root", "roots"), ("target", "targets"), ("exclude", "exclude"), ("backend", "backend"), ("everything", "everything_url"), ("output", "output"), ("port", "port")]:
        value = getattr(args, arg, None)
        if value is not None:
            config[field] = value
    for field in ("roots", "targets", "exclude"):
        if not isinstance(config[field], list) or any(not isinstance(v, str) or not v.strip() or '"' in v for v in config[field]):
            raise ValueError(field + " must be a list of non-empty strings without double quotes")
    if not config["roots"] or not config["targets"]:
        raise ValueError("roots and targets must not be empty")
    for field in ("roots", "exclude"):
        config[field] = list(dict.fromkeys(str((base / p).resolve()) for p in config[field]))
    config["output"] = str((base / config["output"]).resolve())
    if any(inside(config["output"], r) for r in config["roots"]):
        raise ValueError("Output must be outside all collection roots to avoid indexing generated files")
    for i, a in enumerate(config["roots"]):
        for b in config["roots"][i + 1:]:
            if inside(a, b) or inside(b, a):
                raise ValueError("Collection roots must not contain each other: " + a + " / " + b)
    if config["backend"] not in ("everything", "filesystem"):
        raise ValueError("backend must be everything or filesystem")
    for field, lo, hi in [("port", 0, 65535), ("workers", 1, 16), ("page_size", 1, 10000), ("timeout", 1, 600)]:
        if isinstance(config[field], bool) or not isinstance(config[field], int) or not lo <= config[field] <= hi:
            raise ValueError(f"{field} must be an integer between {lo} and {hi}")
    url = urllib.parse.urlsplit(config["everything_url"])
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("everything_url must be an HTTP(S) URL; use the separate username/password fields")
    return config


class Builder:
    def __init__(self, config: dict, progress=print):
        self.config = config
        self.progress = progress
        self.roots = [Path(p) for p in config["roots"]]
        self.output = Path(config["output"])
        self.headers = {}
        if config["everything_username"]:
            pair = config["everything_username"] + ":" + config["everything_password"]
            self.headers["Authorization"] = "Basic " + base64.b64encode(pair.encode()).decode()

    def excluded(self, path: str | Path) -> bool:
        return any(inside(path, e) for e in self.config["exclude"])

    def matches(self, path: Path, root: Path) -> bool:
        rel = str(path.relative_to(root)).replace("\\", "/")
        absolute = str(path).replace("\\", "/")
        for target in self.config["targets"]:
            pattern = target.replace("\\", "/")
            candidate = absolute if Path(target).is_absolute() else rel if "/" in pattern or pattern == "." else path.name
            if glob_match(candidate, pattern):
                return True
        return False

    def query(self, search: str) -> list[dict]:
        rows: list[dict] = []
        total = None
        offset = 0
        seen: set[str] = set()
        while total is None or offset < total:
            params = {"search": search, "json": 1, "count": self.config["page_size"], "offset": offset, "path_column": 1, "size_column": 1, "sort": "path", "ascending": 1}
            url = self.config["everything_url"].rstrip("/") + "/?" + urllib.parse.urlencode(params)
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=self.headers), timeout=self.config["timeout"]) as response:
                    result = json.load(response)
            except Exception as exc:
                raise RuntimeError(f"Everything query failed: {exc}. Check the HTTP server, URL and authentication. No filesystem fallback was used.") from exc
            if not isinstance(result, dict) or not isinstance(result.get("totalResults"), int) or not isinstance(result.get("results"), list):
                raise RuntimeError("Everything did not return the expected JSON. Check that its HTTP server is enabled.")
            if total is not None and total != result["totalResults"]:
                raise RuntimeError("Everything result count changed during pagination. Wait for indexing to finish and retry.")
            total = result["totalResults"]
            page = result["results"]
            if not page and offset < total:
                raise RuntimeError("Incomplete Everything pagination; existing HTML is preserved")
            for row in page:
                if row.get("type") not in ("file", "folder") or not isinstance(row.get("name"), str) or not isinstance(row.get("path"), str):
                    raise RuntimeError("An Everything result is missing its type, name or path")
                identity = key(Path(row["path"]) / row["name"])
                if identity in seen:
                    raise RuntimeError("Duplicate Everything pagination entries. The index may be changing; please retry.")
                seen.add(identity)
            rows.extend(page)
            offset += len(page)
        if offset != total:
            raise RuntimeError("Everything pagination count mismatch")
        return rows

    def walk(self, top: Path, files: bool = True):
        """Filesystem backend: yield (path, kind, size) below top, skipping links, junctions and exclusions."""
        def failed(error):
            raise error

        def keep(path: Path) -> bool:
            return not self.excluded(path) and not path.is_symlink() and not getattr(path, "is_junction", lambda: False)()
        for parent, dirs, names in os.walk(top, followlinks=False, onerror=failed):
            base = Path(parent)
            dirs[:] = [d for d in dirs if keep(base / d)]
            yield from ((base / d, "folder", 0) for d in dirs)
            if files:
                for name in names:
                    path = base / name
                    if keep(path):
                        yield path, "file", path.stat().st_size

    def discover(self) -> list[tuple[Path, Path]]:
        found: dict[str, tuple[Path, Path]] = {}
        for root in self.roots:
            if not root.is_dir():
                raise FileNotFoundError("Collection root does not exist or is inaccessible: " + str(root))
            if self.excluded(root):
                continue
            if self.matches(root, root):
                found[key(root)] = (root, root)
            self.progress("Finding selected folders: " + str(root))
            if self.config["backend"] == "everything":
                # Folder metadata comes entirely from Everything, not os.walk.
                paths = [Path(r["path"]) / r["name"] for r in self.query('folder: "' + str(root) + os.sep + '"')]
            else:
                paths = [path for path, _, _ in self.walk(root, files=False)]
            for path in paths:
                if not inside(path, root):
                    raise RuntimeError("Index result is outside the requested folder: " + str(path))
                if self.matches(path, root) and not self.excluded(path):
                    found[key(path)] = (root, path)
        return sorted(found.values(), key=lambda pair: key(pair[1]))

    def fetch(self, pair: tuple[Path, Path]) -> tuple[Path, Path, list[tuple[Path, str, int]]]:
        root, target = pair
        if not target.is_dir():
            raise FileNotFoundError("An Everything target no longer exists; the index may be stale: " + str(target))
        entries = [(target, "folder", 0)]
        if self.config["backend"] == "everything":
            for row in self.query('"' + str(target) + os.sep + '"'):
                path = Path(row["path"]) / row["name"]
                if not inside(path, target):
                    raise RuntimeError("Index result is outside the requested folder: " + str(path))
                if not self.excluded(path):
                    entries.append((path, row["type"], int(row.get("size") or 0)))
        else:
            entries.extend(self.walk(target))
        self.progress("Read: " + str(target))
        return root, target, entries

    def tree(self, title: str, results: list[tuple[Path, Path, list[tuple[Path, str, int]]]], targets: set[str]) -> dict:
        """Merge fetched entries into one compact tree.

        Folders are [name, files, bytes, children, isTarget]; files are [name, size].
        Full paths are rebuilt in the page from each root's path.
        """
        tops: dict[str, dict] = {}
        seen: dict[str, tuple[str, int]] = {}
        for root, _, entries in results:
            top = tops.setdefault(key(root), {"name": root.name or str(root), "kind": "folder", "children": {}})
            for path, kind, size in entries:
                if seen.setdefault(key(path), (kind, size)) != (kind, size):
                    raise RuntimeError("Conflicting index entries: " + str(path))
                node = top
                for part in path.relative_to(root).parts:
                    node = node["children"].setdefault(os.path.normcase(part), {"name": part, "kind": "folder", "size": 0, "children": {}})
                if node is not top:
                    node["kind"], node["size"] = kind, size
        stats = {"depth": 1, "folders": 0}

        def pack(node: dict, path: Path, depth: int) -> tuple[list, int, int]:
            stats["depth"] = max(stats["depth"], depth)
            if node["kind"] == "file":
                return [node["name"], node["size"]], 1, node["size"]
            stats["folders"] += 1
            children, files, total = [], 0, 0
            for child in sorted(node["children"].values(), key=lambda c: (c["kind"] != "folder", natural(c["name"]))):
                packed, f, b = pack(child, path / child["name"], depth + 1)
                children.append(packed)
                files += f
                total += b
            return [node["name"], files, total, children, int(key(path) in targets)], files, total
        roots, files, total = [], 0, 0
        for root in self.roots:
            if key(root) in tops:
                packed, f, b = pack(tops[key(root)], root, 1)
                roots.append({"path": str(root), "tree": packed})
                files += f
                total += b
        if files != sum(kind == "file" for kind, _ in seen.values()):
            raise RuntimeError("Tree file-count verification failed")
        return {"categoryName": title, "generatedAt": stamp(), "roots": roots, "categoryCount": len(targets), "fileCount": files,
                "folderCount": stats["folders"], "bytes": total, "maxDepth": stats["depth"], "source": self.config["backend"],
                "selectors": self.config["targets"], "excluded": self.config["exclude"]}

    def build(self, service: dict) -> list[dict]:
        selected = self.discover()
        if not selected:
            raise RuntimeError("No folders matched. Check targets or the Everything index. Existing HTML is unchanged.")
        groups: dict[str, list[tuple[Path, Path]]] = {}
        for pair in selected:
            groups.setdefault(pair[1].name, []).append(pair)
        # Query only outermost matches in each index; retain nested matches as tags.
        outer = {title: [p for p in pairs if not any(p[1] != o[1] and inside(p[1], o[1]) for o in pairs)] for title, pairs in groups.items()}
        jobs = [p for pairs in outer.values() for p in pairs]
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.config["workers"]) as pool:
            fetched = {key(p[1]): result for p, result in zip(jobs, pool.map(self.fetch, jobs))}
        data = [self.tree(title, [fetched[key(p[1])] for p in outer[title]], {key(p[1]) for p in groups[title]})
                for title in sorted(groups, key=str.casefold)]
        self.output.mkdir(parents=True, exist_ok=True)
        live = []
        used = set()
        for snapshot in data:
            safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", snapshot["categoryName"]).strip(". ")[:100] or "Folder"
            filename = safe + " Tree.html"
            if filename.casefold() in used:
                filename = safe + "_" + hashlib.sha256(snapshot["categoryName"].encode()).hexdigest()[:8] + " Tree.html"
            used.add(filename.casefold())
            live.append({"title": snapshot["categoryName"], "href": filename, "files": snapshot["fileCount"], "bytes": snapshot["bytes"],
                         "targets": snapshot["categoryCount"], "generatedAt": snapshot["generatedAt"]})
        live_names = {i["href"] for i in live}
        indexes = sorted(live + [i for i in discover_indexes(self.output) if i["href"] not in live_names], key=index_order)
        # No output is replaced until every query and count check has succeeded.
        for snapshot, entry in zip(data, live):
            atomic_write(self.output / entry["href"], render(snapshot, entry, indexes, service))
        atomic_write(self.output / "index.html", render(None, {"title": "Collection Tree", "href": "index.html"}, indexes, service))
        atomic_write(self.output / "indexes.json", json.dumps(indexes, ensure_ascii=False, indent=2))
        atomic_write(self.output / "indexes.js", indexes_script(indexes, service))
        atomic_write(self.output / "build-config.json", json.dumps(self.config, ensure_ascii=False, indent=2))
        self.progress("Build complete: " + ", ".join(f'{i["title"]} {i["files"]:,} files' for i in live))
        return indexes


def discover_indexes(output: Path) -> list[dict]:
    indexes = []
    for path in sorted(output.glob("*.html")):
        if path.name == "index.html":
            continue
        try:
            with path.open(encoding="utf-8") as source:
                head = source.read(16384)
            match = re.search(r'<meta name="' + MARKER + r'" content="([^"]+)">', head)
            if match:
                item = json.loads(html.unescape(match.group(1)))
                item["href"] = path.name
                indexes.append(item)
        except (OSError, ValueError):
            continue
    return sorted(indexes, key=index_order)


def indexes_script(indexes: list[dict], service: dict) -> str:
    return "window.COLLECTION_INDEXES=" + js_json(indexes) + ";window.COLLECTION_SERVICE=" + js_json(service) + ";"


def service_info(config: dict, token: str) -> dict:
    return {"url": f'http://127.0.0.1:{config["port"]}', "token": token, "script": str(SCRIPT), "scriptURL": SCRIPT.as_uri(),
            "command": command(config), "reveal": os.name == "nt"}


def render(data: dict | None, entry: dict, indexes: list[dict], service: dict) -> str:
    values = {
        "TITLE": html.escape(entry["title"]),
        "PAGETITLE": html.escape(entry["title"] if data is None else entry["title"] + " · Collection Tree"),
        "META": '<meta name="' + MARKER + '" content="' + html.escape(json.dumps(entry, ensure_ascii=False), quote=True) + '">',
        "DATA": js_json(data),
        "INDEXES": js_json(indexes),
        "SERVICE": js_json(service),
    }
    # One pass, so placeholder-like text inside the data is never substituted again.
    return re.sub(r"@@([A-Z]+)@@", lambda m: values[m[1]], TEMPLATE)


class BuildService:
    def __init__(self, config: dict, token: str):
        self.config = config
        self.info = service_info(config, token)
        self.lock = threading.Lock()
        self.state: dict = {"running": False, "message": "Service is ready", "error": None, "revision": 0, "log": []}

    def progress(self, message: str) -> None:
        print(message, flush=True)
        with self.lock:
            self.state["message"] = message
            self.state["log"] = (self.state["log"] + [message])[-30:]

    def start(self) -> bool:
        with self.lock:
            if self.state["running"]:
                return False
            self.state.update(running=True, error=None, message="Starting a rebuild", log=[])

        def work():
            try:
                Builder(self.config, self.progress).build(self.info)
                with self.lock:
                    self.state["revision"] += 1
            except Exception as exc:
                traceback.print_exc()
                with self.lock:
                    self.state["error"] = str(exc)
                    self.state["message"] = "Build failed. Previous pages are still available."
            finally:
                with self.lock:
                    self.state["running"] = False
        threading.Thread(target=work, daemon=True).start()
        return True

    def reveal(self, raw: object) -> tuple[int, str]:
        """Select a collection path in Windows Explorer. Only paths inside the configured roots are accepted."""
        if not self.info["reveal"]:
            return 501, "Show in Explorer is only available on Windows"
        if not isinstance(raw, str) or not raw or '"' in raw or "\x00" in raw or not Path(raw).is_absolute():
            return 400, "Invalid path"
        path = os.path.abspath(raw)
        if not any(inside(path, r) for r in self.config["roots"]) or any(inside(path, e) for e in self.config["exclude"]):
            return 403, "Path is outside the collection roots"
        if not os.path.exists(path):
            return 404, "Path no longer exists"
        subprocess.Popen('explorer /select,"' + path + '"')
        return 200, "Opened in Explorer"


def handler_for(service: BuildService):
    output = Path(service.config["output"])

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            if self.path.startswith("/__tree/status"):
                return
            super().log_message(fmt, *args)

        def allowed_origin(self) -> bool:
            return self.headers.get("Origin") in (None, "null", service.info["url"])

        def cross_site(self) -> bool:
            # Pages, indexes.js and the script carry the token or private paths: other sites must not
            # embed them (a <script src> sends no Origin header, but browsers do send Sec-Fetch-Site).
            return self.headers.get("Sec-Fetch-Site") in ("cross-site", "same-site")

        def send(self, body: bytes, kind: str, status=200, cors=True):
            self.send_response(status)
            origin = self.headers.get("Origin")
            # Only the API answers offline file:// pages (Origin: null); pages and scripts never do.
            if cors and origin in ("null", service.info["url"]):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(body)

        def respond(self, value: object, status=200):
            self.send(json.dumps(value, ensure_ascii=False).encode(), "application/json; charset=utf-8", status)

        def valid_host(self) -> bool:
            return self.headers.get("Host") == urllib.parse.urlsplit(service.info["url"]).netloc

        def do_OPTIONS(self):
            if not self.valid_host() or not self.allowed_origin():
                self.respond({"error": "Origin is not allowed"}, 403)
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or service.info["url"])
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Tree-Token")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.end_headers()

        def do_GET(self):
            if not self.valid_host() or not self.allowed_origin():
                self.respond({"error": "Origin is not allowed"}, 403)
                return
            route = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
            if route == "/__tree/status":
                with service.lock:
                    # Features let pages built by a newer script hide actions an older running service lacks.
                    self.respond(dict(service.state, features=["rebuild"] + ["reveal"] * service.info["reveal"]))
                return
            if self.cross_site():
                self.respond({"error": "Cross-site request is not allowed"}, 403)
                return
            if route == "/__tree/indexes":
                self.respond(discover_indexes(output))
                return
            if route == "/__tree/script":
                self.send(SCRIPT.read_bytes(), "text/plain; charset=utf-8", cors=False)
                return
            name = route.lstrip("/") or "index.html"
            path = (output / name).resolve()
            # Serve only generated public artifacts, never configs or credentials.
            if path.parent != output.resolve() or not (path.suffix == ".html" or path.name == "indexes.js") or not path.is_file():
                self.respond({"error": "Page not found"}, 404)
                return
            if path.suffix == ".html":
                # Pages take the live service URL and token from indexes.js, so they are served unchanged.
                self.send(path.read_bytes(), "text/html; charset=utf-8", cors=False)
            else:
                # The runtime URL can change when a user selects another port.
                self.send(indexes_script(discover_indexes(output), service.info).encode(), "text/javascript; charset=utf-8", cors=False)

        def do_POST(self):
            if not self.valid_host() or not self.allowed_origin() or not secrets.compare_digest(self.headers.get("X-Tree-Token", ""), service.info["token"]):
                self.respond({"error": "Invalid local request"}, 403)
                return
            route = urllib.parse.urlsplit(self.path).path
            if route not in ("/__tree/rebuild", "/__tree/reveal"):
                self.respond({"error": "Endpoint not found"}, 404)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = -1
            if not 0 <= length <= MAX_BODY:
                self.respond({"error": "Request is too large"}, 413)
                return
            body = self.rfile.read(length)
            if route == "/__tree/reveal":
                try:
                    raw = json.loads(body or b"{}").get("path")
                except (ValueError, AttributeError):
                    raw = None
                status, text = service.reveal(raw)
                self.respond({"message": text} if status == 200 else {"error": text}, status)
                return
            started = service.start()
            self.respond({"started": started, "message": "Rebuild started" if started else "A rebuild is already running"}, 202)
    return Handler


TEMPLATE = r'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
@@META@@
<title>@@PAGETITLE@@</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%232f5d8a' d='M2 5h8l2 3h12v13H2z'/%3E%3C/svg%3E">
<script>try{const t=localStorage.getItem('collection-tree-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}</script>
<style>
:root{--bg:#f5f4f1;--panel:#fffffe;--side:#eeece7;--ink:#1d2127;--muted:#646a73;--faint:#8f959d;--line:#e2dfd8;--line2:#cfcbc2;--accent:#2f5d8a;--accent-ink:#fff;--accent-soft:#e3ecf6;--hover:#f2f0eb;--sel:#dce8f5;--mark:#fbe38a;--guide:#e3e0d9;--shadow:0 1px 2px rgba(30,30,20,.06),0 4px 16px rgba(30,30,20,.05);
--folder:#c2953a;--audio:#7a57c2;--image:#23866a;--video:#c24f36;--disc:#a8701a;--doc:#5a6676;--other:#8d949c;--row:30px;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15171a;--panel:#1b1e22;--side:#181a1e;--ink:#e5e7ea;--muted:#a0a7b0;--faint:#6f7780;--line:#2a2e34;--line2:#3a3f47;--accent:#86b4e8;--accent-ink:#0d1520;--accent-soft:#1d2a39;--hover:#22262b;--sel:#213349;--mark:#76601a;--guide:#2b2f35;--shadow:0 1px 2px rgba(0,0,0,.3);--folder:#d9b464;--audio:#ad93f2;--image:#5fc8a1;--video:#ee8a73;--disc:#e2b35a;--doc:#9fabba;--other:#7b838c;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#15171a;--panel:#1b1e22;--side:#181a1e;--ink:#e5e7ea;--muted:#a0a7b0;--faint:#6f7780;--line:#2a2e34;--line2:#3a3f47;--accent:#86b4e8;--accent-ink:#0d1520;--accent-soft:#1d2a39;--hover:#22262b;--sel:#213349;--mark:#76601a;--guide:#2b2f35;--shadow:0 1px 2px rgba(0,0,0,.3);--folder:#d9b464;--audio:#ad93f2;--image:#5fc8a1;--video:#ee8a73;--disc:#e2b35a;--doc:#9fabba;--other:#7b838c;color-scheme:dark}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 "Segoe UI Variable Text","Segoe UI","Yu Gothic UI","Microsoft YaHei UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
button,input,select{font:inherit;color:inherit}a{color:var(--accent);text-underline-offset:3px}[hidden]{display:none!important}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
svg.i,.btn svg,.ico,.chev svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
.btn{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 13px;background:var(--panel);border:1px solid var(--line2);border-radius:7px;cursor:pointer;text-decoration:none;color:var(--ink);white-space:nowrap;transition:background .12s,border-color .12s}
.btn:hover{background:var(--hover)}.btn:disabled{opacity:.5;cursor:default}.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}.btn.primary:hover{filter:brightness(1.08)}.btn.small{height:28px;padding:0 10px;font-size:12.5px}.btn.square{width:34px;padding:0;justify-content:center}
.app{display:grid;grid-template-columns:272px minmax(0,1fr);height:100vh;height:100dvh}
.side{display:flex;flex-direction:column;min-height:0;background:var(--side);border-right:1px solid var(--line);padding:20px 14px 14px}
.brand{display:flex;align-items:center;gap:10px;padding:4px 10px 18px;color:var(--ink);text-decoration:none;font-weight:650;font-size:15.5px;letter-spacing:-.1px}.brand svg{width:22px;height:22px;color:var(--accent)}
.side-label{margin:0 10px 6px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
nav.indexes{display:grid;gap:2px;overflow:auto;min-height:0;flex:1;align-content:start;margin:0 -4px;padding:0 4px}
nav.indexes a{display:grid;gap:1px;padding:8px 10px;border-radius:7px;text-decoration:none;color:var(--ink)}nav.indexes a:hover{background:var(--hover)}
nav.indexes a[aria-current]{background:var(--panel);box-shadow:var(--shadow),inset 3px 0 var(--accent)}nav.indexes a[aria-current] .nav-title{color:var(--accent);font-weight:600}
.nav-title{overflow-wrap:anywhere}.nav-meta{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.side-foot{display:flex;align-items:flex-end;gap:8px;border-top:1px solid var(--line);padding-top:12px;margin-top:12px}
.service{flex:1;min-width:0;font-size:12.5px;color:var(--muted)}.service summary{cursor:pointer;padding:7px 4px;border-radius:6px;list-style:none;display:flex;align-items:center;gap:6px}.service summary::-webkit-details-marker{display:none}.service summary:hover{color:var(--ink)}
.service[open] summary{color:var(--ink)}.service dl{margin:6px 4px 10px;display:grid;gap:2px}.service dt{font-weight:600;color:var(--ink);margin-top:6px}.service dd{margin:0;overflow-wrap:anywhere}
.service code{display:block;font:11.5px/1.45 ui-monospace,Consolas,monospace;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px;margin:8px 4px;word-break:break-all;color:var(--ink);max-height:120px;overflow:auto}.service p{margin:8px 4px}.service .btn{margin:0 4px}
.main{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:auto;padding:22px 28px 18px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:16px}
h1{margin:0 0 8px;font-size:26px;line-height:1.25;font-weight:650;letter-spacing:-.4px}
.stats{display:flex;flex-wrap:wrap;gap:6px}.chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:2px 9px;border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--muted);font-variant-numeric:tabular-nums}.chip b{color:var(--ink);font-weight:600}
.actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.message{display:flex;gap:10px;align-items:flex-start;padding:10px 14px;margin:0 0 14px;background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);border-radius:8px;overflow-wrap:anywhere;font-size:13px}
.message.error{background:color-mix(in srgb,var(--video) 12%,var(--panel));border-color:color-mix(in srgb,var(--video) 40%,transparent)}
.spinner{width:14px;height:14px;margin-top:3px;flex:none;border:2px solid color-mix(in srgb,var(--accent) 30%,transparent);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(1turn)}}
.treeui{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.searchbox{flex:1 1 320px;position:relative;display:flex;align-items:center}.searchbox>svg{position:absolute;left:11px;color:var(--faint);pointer-events:none}
.searchbox input{width:100%;height:36px;padding:0 40px 0 34px;background:var(--panel);border:1px solid var(--line2);border-radius:8px}.searchbox input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.searchbox kbd{position:absolute;right:9px;font:11px ui-monospace,Consolas,monospace;color:var(--faint);border:1px solid var(--line2);border-radius:4px;padding:0 5px;line-height:17px;pointer-events:none}.searchbox input:focus~kbd,.searchbox input:not(:placeholder-shown)~kbd{display:none}
select{height:36px;padding:0 30px 0 11px;background:var(--panel);border:1px solid var(--line2);border-radius:8px;cursor:pointer;max-width:100%;appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 15px) 16px,calc(100% - 10px) 16px;background-size:5px 5px;background-repeat:no-repeat}
#scope{max-width:250px}.levels{display:inline-flex;align-items:center;height:36px;border:1px solid var(--line2);border-radius:8px;background:var(--panel);overflow:hidden}.levels button{width:32px;height:100%;border:0;background:none;cursor:pointer;font-size:16px;color:var(--muted)}.levels button:hover:not(:disabled){background:var(--hover);color:var(--ink)}.levels button:disabled{opacity:.35;cursor:default}
.levels span{min-width:66px;text-align:center;font-size:12.5px;font-variant-numeric:tabular-nums;border-inline:1px solid var(--line)}
.toolbar .btn{height:36px}
.panel{flex:1;min-height:320px;display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);overflow:hidden}
.panel-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.legend{display:flex;gap:4px;flex-wrap:wrap}.legend button{display:inline-flex;align-items:center;gap:5px;border:0;background:none;padding:2px 7px;border-radius:5px;cursor:pointer;color:var(--muted);font-size:12px}.legend button:hover{background:var(--hover);color:var(--ink)}.legend button[aria-pressed="true"]{background:var(--accent-soft);color:var(--ink)}
.dot{width:8px;height:8px;border-radius:50%;background:currentColor}
.viewport{flex:1;min-height:0;overflow:auto;position:relative;outline:none;overscroll-behavior:contain}
.rows{position:absolute;left:0;right:0;top:0;padding:0 6px;will-change:transform}
.row{display:flex;align-items:center;gap:6px;height:var(--row);padding:0 12px 0 calc(var(--d)*20px + 6px);border-radius:6px;cursor:pointer;white-space:nowrap;user-select:none;background-image:repeating-linear-gradient(to right,var(--guide) 0 1px,transparent 1px 20px);background-size:calc(var(--d)*20px) 100%;background-repeat:no-repeat;background-position:14px 0}
.row:hover{background-color:var(--hover)}.row.chosen{background-color:var(--sel)}.viewport:focus-visible .row.current{box-shadow:inset 0 0 0 2px var(--accent)}
.chev{width:16px;height:16px;display:grid;place-items:center;color:var(--faint);border-radius:4px;flex:none}.chev svg{width:13px;height:13px;stroke-width:2.2;transition:transform .12s}.chev.open svg{transform:rotate(90deg)}.chev[data-toggle]:hover{background:var(--line);color:var(--ink)}
.ico{width:17px;height:17px}.t-folder{color:var(--folder);fill:color-mix(in srgb,var(--folder) 22%,transparent)}.t-audio{color:var(--audio)}.t-image{color:var(--image)}.t-video{color:var(--video)}.t-disc{color:var(--disc)}.t-doc{color:var(--doc)}.t-other{color:var(--other)}
.name{min-width:0;overflow:hidden;text-overflow:ellipsis}.row.chosen .name{font-weight:550}
.meta{flex:none;margin-left:8px;font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums}
.tag{flex:none;font-size:10.5px;font-weight:600;letter-spacing:.02em;color:var(--accent);background:var(--accent-soft);border-radius:4px;padding:0 6px;line-height:18px}
mark{background:var(--mark);color:inherit;border-radius:2px;padding:0 1px}
.empty{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:6px;color:var(--muted);text-align:center;padding:20px}.empty svg{width:28px;height:28px;color:var(--faint)}
.selection{display:flex;align-items:center;gap:10px;padding:8px 10px 8px 14px;border-top:1px solid var(--line);background:color-mix(in srgb,var(--side) 55%,var(--panel))}
.crumbs{flex:1;min-width:0;display:flex;align-items:center;gap:2px;overflow-x:auto;scrollbar-width:none;font-size:12.5px;white-space:nowrap}.crumbs::-webkit-scrollbar{display:none}
.crumb{border:0;background:none;padding:3px 6px;border-radius:5px;cursor:pointer;color:var(--muted);max-width:340px;overflow:hidden;text-overflow:ellipsis;flex:none}.crumb:hover{background:var(--hover);color:var(--ink)}.crumb:last-child{color:var(--ink);font-weight:600}.sep{color:var(--faint);flex:none}.placeholder{color:var(--faint)}
.sel-actions{display:flex;gap:6px;flex:none}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px;align-content:start}
.card{display:grid;gap:14px;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);text-decoration:none;color:var(--ink);transition:border-color .12s,transform .12s}.card:hover{border-color:var(--accent);transform:translateY(-1px)}
.card h2{margin:0;font-size:17px;font-weight:620;line-height:1.35}.card dl{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0}.card dt{font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.05em}.card dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums}.card small{color:var(--muted);font-size:12px}
.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:8px 16px;border-radius:8px;z-index:9;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.2)}
@media (max-width:860px){.app{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}.side{flex-direction:row;align-items:center;gap:8px;padding:10px 16px;border-right:0;border-bottom:1px solid var(--line)}.brand{padding:0;font-size:0;gap:0}.side-label{display:none}
nav.indexes{display:flex;flex:1;overflow-x:auto;margin:0;padding:0;scrollbar-width:none}#scope,#show{flex:1 1 130px;max-width:none}nav.indexes a{flex:none;padding:5px 10px}.nav-meta{display:none}.side-foot{border:0;margin:0;padding:0}.service{display:none}
.main{padding:16px 16px 12px}.top{flex-direction:column;gap:10px}h1{font-size:22px}.actions{justify-content:flex-start}.toolbar .btn span{display:none}.legend{display:none}.crumb{max-width:200px}.meta{display:none}.row.leaf .meta,.row.chosen .meta{display:inline}}
</style></head><body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
<symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4.2l2 2.4H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></symbol>
<symbol id="i-folder-open" viewBox="0 0 24 24"><path d="M3 18V7a2 2 0 0 1 2-2h4.2l2 2.4H18a2 2 0 0 1 2 2V11"/><path d="M3 18l2.4-6.2A1.6 1.6 0 0 1 6.9 10.8h13.7a1 1 0 0 1 .95 1.3l-2.1 6.5A2 2 0 0 1 17.5 20H5a2 2 0 0 1-2-2z"/></symbol>
<symbol id="i-file" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></symbol>
<symbol id="i-audio" viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></symbol>
<symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></symbol>
<symbol id="i-video" viewBox="0 0 24 24"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/></symbol>
<symbol id="i-disc" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></symbol>
<symbol id="i-doc" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h5"/></symbol>
<symbol id="i-chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></symbol>
<symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></symbol>
<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/></symbol>
<symbol id="i-external" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></symbol>
<symbol id="i-expand" viewBox="0 0 24 24"><path d="m7 9 5-5 5 5M7 15l5 5 5-5"/></symbol>
<symbol id="i-collapse" viewBox="0 0 24 24"><path d="m7 4 5 5 5-5M7 20l5-5 5 5"/></symbol>
<symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></symbol>
<symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></symbol>
<symbol id="i-gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.8 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 14H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.8 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 10h0a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></symbol>
</svg>
<div class="app">
<aside class="side">
 <a class="brand" href="index.html"><svg class="i"><use href="#i-folder-open"/></svg><span>Collection Tree</span></a>
 <p class="side-label">Indexes</p>
 <nav class="indexes" id="nav" aria-label="Tree indexes"></nav>
 <div class="side-foot">
  <details class="service"><summary><svg class="i"><use href="#i-gear"/></svg>Service &amp; configuration</summary>
   <dl><dt>Script</dt><dd><a id="scriptLink"></a></dd><dt>Selection rules</dt><dd id="rules">—</dd><dt>Excluded</dt><dd id="excluded">—</dd></dl>
   <code id="launchCommand"></code><button class="btn small" id="copyCommand"><svg><use href="#i-copy"/></svg>Copy launch command</button>
   <p>Keep the service running to rebuild or show items in Explorer. Restart it after editing settings.json.</p>
  </details>
  <button class="btn square" id="theme" type="button"></button>
 </div>
</aside>
<main class="main">
 <header class="top">
  <div><h1>@@TITLE@@</h1><div class="stats" id="stats"></div></div>
  <div class="actions"><a class="btn" id="serviceLink" hidden><svg><use href="#i-external"/></svg>Open in local service</a><button class="btn primary" id="rebuild" type="button"><svg><use href="#i-refresh"/></svg>Rebuild all</button></div>
 </header>
 <div id="message" class="message" role="status" hidden><span class="spinner" id="spinner" hidden></span><span id="messageText"></span></div>
 <section class="treeui" id="treeUI" hidden>
  <div class="toolbar">
   <label class="searchbox"><svg class="i"><use href="#i-search"/></svg><input type="search" id="search" placeholder="Search names or paths (space = AND)" aria-label="Search names or full paths" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>
   <select id="scope" aria-label="Collection root"><option value="all">All collections</option></select>
   <select id="show" aria-label="Show"><option value="all">All files</option><option value="folders">Folders only</option><option value="audio">Audio</option><option value="image">Images</option><option value="video">Video</option><option value="disc">Discs &amp; archives</option><option value="doc">Documents</option><option value="other">Other files</option></select>
   <div class="levels" role="group" aria-label="Expand level"><button id="less" type="button" aria-label="Collapse one level">−</button><span id="levelValue"></span><button id="more" type="button" aria-label="Expand one more level">+</button></div>
   <button class="btn" id="expand" type="button" title="Expand all"><svg><use href="#i-expand"/></svg><span>Expand all</span></button>
   <button class="btn" id="collapse" type="button" title="Collapse all"><svg><use href="#i-collapse"/></svg><span>Collapse</span></button>
  </div>
  <div class="panel">
   <div class="panel-head"><span id="status" aria-live="polite"></span><span class="legend" id="legend"></span></div>
   <div class="viewport" id="viewport" tabindex="0" role="tree" aria-label="Collection tree"><div id="spacer"></div><div class="rows" id="rows"></div>
    <div class="empty" id="empty" hidden><svg class="i"><use href="#i-search"/></svg><b>No matches</b><span>Try other terms, another file type or all collections.</span></div></div>
   <div class="selection"><div class="crumbs" id="crumbs" aria-label="Selected path"></div><div class="sel-actions"><button class="btn small" id="reveal" type="button" hidden><svg><use href="#i-folder-open"/></svg>Show in Explorer</button><a class="btn small" id="openPath" hidden target="_blank" rel="noopener"><svg><use href="#i-external"/></svg>Open</a><button class="btn small" id="copy" type="button" disabled><svg><use href="#i-copy"/></svg>Copy path</button></div></div>
  </div>
 </section>
 <section class="cards" id="indexList" hidden></section>
</main></div>
<div id="toast" class="toast" role="status" hidden></div>
<script type="application/json" id="treeData">@@DATA@@</script><script type="application/json" id="indexData">@@INDEXES@@</script><script type="application/json" id="serviceData">@@SERVICE@@</script><script src="indexes.js"></script>
<script>
'use strict';
const $=id=>document.getElementById(id);
const DATA=JSON.parse($('treeData').textContent),SERVICE=window.COLLECTION_SERVICE||JSON.parse($('serviceData').textContent),INITIAL=window.COLLECTION_INDEXES||JSON.parse($('indexData').textContent);
const page=decodeURIComponent(location.pathname.split('/').pop()||'index.html'),onService=location.origin===SERVICE.url,num=new Intl.NumberFormat();
const esc=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const icon=(id,cls='')=>`<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const when=s=>new Date(s).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
let toastTimer,features=[];
function size(v){let i=0;const u=['B','KB','MB','GB','TB','PB'];while(v>=1024&&i<5){v/=1024;i++}return (i?v.toFixed(v<10?2:v<100?1:0):String(v))+' '+u[i]}
function toast(t){$('toast').textContent=t;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,2200)}
async function copy(t){try{await navigator.clipboard.writeText(t);toast('Copied to clipboard')}catch{const box=document.createElement('textarea');box.value=t;document.body.append(box);box.select();const ok=document.execCommand('copy');box.remove();toast(ok?'Copied to clipboard':'Automatic copy failed. Copy the path manually.')}}
function chips(items){$('stats').innerHTML=items.filter(Boolean).map(([b,t])=>`<span class="chip">${b!==''?`<b>${esc(String(b))}</b>`:''}${esc(t)}</span>`).join('')}
function theme(){return document.documentElement.dataset.theme||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}
function themeButton(){const dark=theme()==='dark';$('theme').innerHTML=icon(dark?'sun':'moon');$('theme').title=dark?'Switch to light theme':'Switch to dark theme';$('theme').setAttribute('aria-label',$('theme').title)}
$('theme').onclick=()=>{const next=theme()==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{localStorage.setItem('collection-tree-theme',next)}catch{}themeButton()};themeButton();
function navigation(list){
 $('nav').innerHTML=list.map(i=>`<a href="${esc(encodeURIComponent(i.href))}"${i.href===page?' aria-current="page"':''}><span class="nav-title">${esc(i.title)}</span><span class="nav-meta">${num.format(i.files)} files${i.bytes!=null?' · '+size(i.bytes):''}</span></a>`).join('');
 if(DATA)return;
 $('indexList').innerHTML=list.map(i=>`<a class="card" href="${esc(encodeURIComponent(i.href))}"><h2>${esc(i.title)}</h2><dl><div><dt>Files</dt><dd>${num.format(i.files)}</dd></div><div><dt>Size</dt><dd>${i.bytes!=null?size(i.bytes):'—'}</dd></div><div><dt>Targets</dt><dd>${i.targets!=null?num.format(i.targets):'—'}</dd></div></dl><small>Built ${i.generatedAt?esc(when(i.generatedAt)):'—'}</small></a>`).join('');
 const bytes=list.some(i=>i.bytes!=null)?list.reduce((s,i)=>s+(i.bytes||0),0):null;
 chips([[list.length,' indexes'],[num.format(list.reduce((s,i)=>s+i.files,0)),' files'],bytes!=null&&[size(bytes),'']]);
}
navigation(INITIAL);
if(location.protocol.startsWith('http'))fetch('/__tree/indexes').then(r=>r.ok?r.json():Promise.reject()).then(navigation).catch(()=>{});
$('serviceLink').href=SERVICE.url+'/'+encodeURIComponent(page);$('serviceLink').hidden=onService;
$('scriptLink').textContent=SERVICE.script;$('scriptLink').href=location.protocol.startsWith('http')?'/__tree/script':SERVICE.scriptURL;$('launchCommand').textContent=SERVICE.command;$('copyCommand').onclick=()=>copy(SERVICE.command);
async function api(path,options={},timeout=12000){const response=await fetch(SERVICE.url+'/__tree/'+path,{...options,signal:AbortSignal.timeout(timeout)});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||'Local service returned '+response.status);return body}
const post=(path,body)=>api(path,{method:'POST',headers:{'X-Tree-Token':SERVICE.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
function message(text,{error=false,busy=false}={}){$('messageText').textContent=text;$('message').hidden=false;$('message').classList.toggle('error',error);$('spinner').hidden=!busy}
let onServiceChange=()=>{};
// Ask the running service what it supports; it may be older than this page.
api('status',{},2500).then(s=>{features=s.features||['rebuild'];onServiceChange()}).catch(()=>{});

if(DATA){
 $('treeUI').hidden=false;
 const ROW=30,TYPES={audio:'flac wav mp3 tak ape tta m4a wma ogg opus aac aif aiff dsf dff wv mka mid mpc',image:'jpg jpeg png bmp tif tiff gif webp psd avif heic jxl jfif',video:'mp4 mkv avi m2ts mts ts wmv mov webm mpg mpeg vob flv m4v',disc:'iso bin cue mds mdf ccd img sub nrg cdi zip rar 7z lzh lha cab tar gz xz',doc:'txt log pdf md nfo htm html doc docx rtf xls xlsx csv epub url json xml ini accurip m3u m3u8 sfv md5'},EXT={};
 for(const [t,list] of Object.entries(TYPES))for(const e of list.split(' '))EXT[e]=t;
 const kindOf=name=>{const i=name.lastIndexOf('.');return i>0&&EXT[name.slice(i+1).toLowerCase()]||'other'};
 const join=(p,n)=>/[\\/]$/.test(p)?p+n:p+'\\'+n;
 const NODES=[];
 function make(a,parent,path,depth,root){const n={name:a[0],path,parent,depth,root,dir:a.length>2};NODES.push(n);
  if(n.dir){n.files=a[1];n.bytes=a[2];n.sel=!!a[4];n.children=a[3].map(c=>make(c,n,join(path,c[0]),depth+1,root))}else{n.size=a[1];n.kind=kindOf(n.name)}return n}
 const ROOTS=DATA.roots.map((r,i)=>make(r.tree,null,r.path,1,i));
 chips([[num.format(DATA.categoryCount),' target folders'],[num.format(DATA.fileCount),' files'],[num.format(DATA.folderCount),' folders'],[size(DATA.bytes),''],['','Built '+when(DATA.generatedAt)+' · '+DATA.source]]);
 $('rules').textContent=DATA.selectors.join(', ');$('excluded').textContent=DATA.excluded.join(', ')||'None';
 ROOTS.forEach((r,i)=>$('scope').add(new Option(r.name,String(i))));
 const counts={};for(const n of NODES)if(!n.dir)counts[n.kind]=(counts[n.kind]||0)+1;
 $('legend').innerHTML=Object.entries({audio:'Audio',image:'Images',video:'Video',disc:'Discs',doc:'Docs'}).filter(([k])=>counts[k]).map(([k,label])=>`<button type="button" data-kind="${k}" title="Show only ${label.toLowerCase()} (${num.format(counts[k])})"><span class="dot t-${k}"></span>${label}</button>`).join('');

 const vp=$('viewport'),layer=$('rows'),saved=(()=>{try{return JSON.parse(sessionStorage.getItem('collection-tree-view:'+page))||{}}catch{return{}}})();
 // Default level: the smallest one at which every target folder is visible (a row at depth d shows from level d).
 const targetLevel=Math.max(1,...NODES.filter(n=>n.sel).map(n=>n.depth));
 let userLevel=saved.level||null,level=Math.min(userLevel||targetLevel,DATA.maxDepth),terms=[],visible=null,open=new Set(),rows=[],cur=-1,selected=null,summary={},searchTimer,frame=0;
 $('search').value=saved.search||'';if([...$('scope').options].some(o=>o.value===saved.scope))$('scope').value=saved.scope;if([...$('show').options].some(o=>o.value===saved.show))$('show').value=saved.show;
 const inScope=n=>$('scope').value==='all'||$('scope').value===String(n.root);
 function persist(){try{sessionStorage.setItem('collection-tree-view:'+page,JSON.stringify({search:$('search').value,level:userLevel,scope:$('scope').value,show:$('show').value,selected:selected&&selected.path}))}catch{}}
 function filter(){
  terms=$('search').value.toLowerCase().split(/\s+/).filter(Boolean);
  const show=$('show').value,roots=ROOTS.filter(inScope);let files=0,bytes=0,folders=0;
  if(!terms.length&&show==='all'){visible=null;for(const r of roots){files+=r.files;bytes+=r.bytes}summary={files,bytes};return}
  visible=new Set();
  const hit=n=>!terms.length||terms.every(t=>(n.lp??=n.path.toLowerCase()).includes(t));
  const visit=n=>{
   if(!n.dir){if(show==='folders'||(show!=='all'&&n.kind!==show)||!hit(n))return false;visible.add(n);files++;bytes+=n.size;return true}
   let any=false;for(const c of n.children)if(visit(c))any=true;
   if(any||((show==='all'||show==='folders')&&hit(n))){visible.add(n);folders++;return true}return false};
  roots.forEach(visit);summary={files,bytes,folders,filtered:true};
 }
 function openToLevel(){open.clear();const walk=n=>{if(n.dir&&n.depth<level&&(!visible||visible.has(n))){open.add(n);n.children.forEach(walk)}};ROOTS.forEach(walk)}
 function flatten(){const node=rows[cur];rows=[];const walk=n=>{if(visible&&!visible.has(n))return;rows.push(n);if(n.dir&&open.has(n))for(const c of n.children)walk(c)};ROOTS.filter(inScope).forEach(walk);cur=node?rows.indexOf(node):-1;$('spacer').style.height=rows.length*ROW+'px'}
 function hl(name){
  const low=name.toLowerCase(),marks=[];if(!terms.length||low.length!==name.length)return esc(name);
  for(const t of terms)for(let i=low.indexOf(t);i>=0;i=low.indexOf(t,i+t.length))marks.push([i,i+t.length]);
  marks.sort((a,b)=>a[0]-b[0]);let out='',pos=0;
  for(const [s,e] of marks){if(e<=pos)continue;const st=Math.max(s,pos);out+=esc(name.slice(pos,st))+'<mark>'+esc(name.slice(st,e))+'</mark>';pos=e}
  return out+esc(name.slice(pos));
 }
 function rowHTML(n,i){
  const isOpen=n.dir&&open.has(n),type=n.dir?'folder':n.kind;
  return `<div class="row${n===selected?' chosen':''}${i===cur?' current':''}${n.dir?'':' leaf'}" role="treeitem" id="r${i}" data-i="${i}" aria-level="${n.depth}"${n.dir?` aria-expanded="${isOpen}"`:''} aria-selected="${n===selected}" title="${esc(n.path)}" style="--d:${n.depth-1}">`+
   (n.dir&&n.children.length?`<span class="chev${isOpen?' open':''}" data-toggle>${icon('chev')}</span>`:'<span class="chev"></span>')+
   icon(n.dir?(isOpen?'folder-open':'folder'):type==='other'?'file':type,'ico t-'+type)+`<span class="name">${hl(n.name)}</span>`+(n.sel?'<span class="tag">TARGET</span>':'')+
   `<span class="meta">${n.dir?num.format(n.files)+' files · '+size(n.bytes):size(n.size)}</span></div>`;
 }
 function paint(){
  frame=0;const h=vp.clientHeight||600,top=vp.scrollTop,start=Math.max(0,Math.floor(top/ROW)-8),end=Math.min(rows.length,Math.ceil((top+h)/ROW)+8);
  layer.style.transform=`translateY(${start*ROW}px)`;
  let html='';for(let i=start;i<end;i++)html+=rowHTML(rows[i],i);layer.innerHTML=html;$('empty').hidden=rows.length>0;
  if(cur>=start&&cur<end)vp.setAttribute('aria-activedescendant','r'+cur);else vp.removeAttribute('aria-activedescendant');
 }
 const schedule=()=>{if(!frame)frame=requestAnimationFrame(paint)};
 vp.addEventListener('scroll',schedule,{passive:true});new ResizeObserver(schedule).observe(vp);
 function status(){
  const s=summary,parts=[`${num.format(s.files)} ${s.filtered?'matching ':''}files`,size(s.bytes)];if(s.filtered)parts.push(num.format(s.folders)+' folders');
  $('status').textContent=parts.join(' · ');$('levelValue').textContent='Level '+level;$('less').disabled=level<=1;$('more').disabled=level>=DATA.maxDepth;
  for(const b of $('legend').children)b.setAttribute('aria-pressed',String(b.dataset.kind===$('show').value));
 }
 function refresh(){flatten();status();paint();persist()}
 function scrollTo(i,center){const h=vp.clientHeight,y=i*ROW;if(center)vp.scrollTop=y-h/2+ROW/2;else if(y<vp.scrollTop)vp.scrollTop=y;else if(y+ROW>vp.scrollTop+h)vp.scrollTop=y+ROW-h}
 function apply(){filter();if(terms.length)open=new Set([...visible].filter(n=>n.dir));else openToLevel();flatten();
  if(selected&&(!visible||visible.has(selected)))reveal(selected,false);else{vp.scrollTop=0;cur=-1;refresh()}}
 function setLevel(l){level=userLevel=Math.max(1,Math.min(DATA.maxDepth,l));openToLevel();refresh()}
 function toggle(n){if(!n.dir||!n.children.length)return;open.has(n)?open.delete(n):open.add(n);refresh()}
 function reveal(n,choose=true){for(let p=n.parent;p;p=p.parent)open.add(p);if(choose)select(n);flatten();cur=rows.indexOf(n);if(cur>=0)scrollTo(cur,true);status();paint();persist()}
 function select(n){
  selected=n;const box=$('crumbs'),chain=[];for(let p=n;p;p=p.parent)chain.unshift(p);box.replaceChildren();
  chain.forEach((p,i)=>{if(i)box.insertAdjacentHTML('beforeend','<span class="sep">›</span>');const b=document.createElement('button');b.type='button';b.className='crumb';b.textContent=i?p.name:p.path;b.title=p.path;b.onclick=()=>{reveal(p);vp.focus({preventScroll:true})};box.append(b)});
  box.scrollLeft=box.scrollWidth;$('copy').disabled=false;onServiceChange();
  $('openPath').hidden=location.protocol!=='file:';$('openPath').href='file:///'+n.path.replace(/\\/g,'/').split('/').map((v,i)=>i?encodeURIComponent(v):v).join('/');persist();
 }
 onServiceChange=()=>{$('reveal').hidden=!(features.includes('reveal')&&selected)};
 $('crumbs').innerHTML='<span class="placeholder">Select a folder or file to see and copy its full path</span>';
 layer.addEventListener('click',e=>{const row=e.target.closest('.row');if(!row)return;const n=rows[cur=+row.dataset.i];vp.focus({preventScroll:true});if(e.target.closest('[data-toggle]')){toggle(n);return}select(n);if(n.dir&&n.children.length)toggle(n);else paint()});
 vp.addEventListener('keydown',e=>{
  if(!rows.length)return;const n=rows[cur],pageRows=Math.max(1,Math.floor(vp.clientHeight/ROW)-1);let next=cur;
  switch(e.key){
   case'ArrowDown':next=Math.min(rows.length-1,cur+1);break;case'ArrowUp':next=Math.max(0,cur-1);break;case'Home':next=0;break;case'End':next=rows.length-1;break;
   case'PageDown':next=Math.min(rows.length-1,cur+pageRows);break;case'PageUp':next=Math.max(0,cur-pageRows);break;
   case'ArrowRight':if(n&&n.dir){if(!open.has(n))toggle(n);else if(rows[cur+1]&&rows[cur+1].parent===n)next=cur+1}break;
   case'ArrowLeft':if(n){if(n.dir&&open.has(n))toggle(n);else if(n.parent)next=rows.indexOf(n.parent)}break;
   case'Enter':case' ':if(n){select(n);if(n.dir)toggle(n);else paint()}break;
   case'c':if((e.ctrlKey||e.metaKey)&&selected&&!String(getSelection())){copy(selected.path);break}return;
   default:return}
  e.preventDefault();if(next<0)next=0;if(next!==cur){cur=next;scrollTo(cur,false)}paint();
 });
 vp.addEventListener('focus',()=>{if(cur<0&&rows.length){cur=0;paint()}});
 $('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(apply,160)};
 $('search').onkeydown=e=>{if(e.key==='Escape'&&$('search').value){e.preventDefault();$('search').value='';apply()}else if(e.key==='Enter'||e.key==='ArrowDown'){e.preventDefault();clearTimeout(searchTimer);apply();if(rows.length){if(cur<0)cur=0;vp.focus({preventScroll:true});paint()}}};
 document.addEventListener('keydown',e=>{if(e.key==='/'&&!/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)){e.preventDefault();$('search').focus();$('search').select()}});
 $('scope').onchange=apply;$('show').onchange=apply;
 $('legend').onclick=e=>{const b=e.target.closest('button');if(!b)return;$('show').value=$('show').value===b.dataset.kind?'all':b.dataset.kind;apply()};
 $('less').onclick=()=>setLevel(level-1);$('more').onclick=()=>setLevel(level+1);$('expand').onclick=()=>setLevel(DATA.maxDepth);$('collapse').onclick=()=>setLevel(1);
 $('copy').onclick=()=>selected&&copy(selected.path);
 $('reveal').onclick=async()=>{try{toast((await post('reveal',{path:selected.path})).message)}catch(e){toast('Could not show in Explorer: '+e.message)}};
 filter();if(terms.length)open=new Set([...visible].filter(n=>n.dir));else openToLevel();
 const restored=saved.selected&&NODES.find(n=>n.path===saved.selected);
 if(restored&&(!visible||visible.has(restored)))reveal(restored);else refresh();
}else{$('indexList').hidden=false}

let busy=false;
$('rebuild').onclick=async()=>{
 if(busy)return;busy=true;$('rebuild').disabled=true;message('Requesting a rebuild…',{busy:true});
 try{await post('rebuild',{});
  for(;;){await new Promise(resolve=>setTimeout(resolve,1000));const state=await api('status');message(state.message,{error:!!state.error,busy:state.running});
   if(!state.running){if(state.error)throw new Error(state.error);message('Build complete. Opening the updated index…',{busy:true});if(location.protocol==='file:')location.href=SERVICE.url+'/'+encodeURIComponent(page);else location.reload();break}}
 }catch(e){message('Rebuild failed: '+e.message+'. If the service is stopped, open “Service & configuration” in the sidebar and run the launch command, or use Open in local service.',{error:true})}finally{busy=false;$('rebuild').disabled=false}
};
</script></body></html>'''


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--build", action="store_true", help="Build static HTML without starting the service")
    mode.add_argument("--serve", action="store_true", help="Serve existing HTML without an immediate rebuild")
    parser.add_argument("--config", help="JSON configuration; relative paths use the configuration directory")
    parser.add_argument("--init-config", metavar="FILE", help="Write a default configuration and exit; never overwrite an existing file")
    parser.add_argument("--root", action="append", help="Collection root; repeat to replace roots")
    parser.add_argument("--target", action="append", help="Folder name wildcard, root-relative path or absolute path; repeat to replace targets")
    parser.add_argument("--exclude", action="append", help="Excluded subtree; repeat to replace exclude")
    parser.add_argument("--backend", choices=("everything", "filesystem"), help="Everything by default; only filesystem mode traverses folders")
    parser.add_argument("--everything", help="Everything HTTP URL")
    parser.add_argument("--output", help="Output directory; defaults to HTML beside the script")
    parser.add_argument("--port", type=int, help="Local port, default 16040; 0 chooses a free port")
    parser.add_argument("--no-browser", action="store_true", help="Do not automatically open the browser")
    args = parser.parse_args()
    if args.init_config:
        path = Path(args.init_config).resolve()
        with path.open("x", encoding="utf-8") as file:
            json.dump(DEFAULT_CONFIG, file, ensure_ascii=False, indent=2)
        print("Configuration example: ", path)
        return 0
    if not args.config and SCRIPT.with_name("settings.json").is_file():
        args.config = str(SCRIPT.with_name("settings.json"))
    config = load_config(args)
    output = Path(config["output"])
    output.mkdir(parents=True, exist_ok=True)
    runtime_path = output / ".server.json"
    try:
        token = json.loads(runtime_path.read_text(encoding="utf-8"))["token"]
        if not isinstance(token, str) or len(token) < 32:
            raise ValueError("invalid token")
    except (OSError, ValueError, KeyError):
        token = secrets.token_urlsafe(32)
    if args.build:
        if not config["port"]:
            raise ValueError("--build does not start a service; choose a fixed port instead of 0")
        atomic_write(runtime_path, json.dumps({"token": token}, ensure_ascii=False))
        Builder(config).build(service_info(config, token))
        print("Home page: ", output / "index.html")
        return 0
    service = BuildService(config, token)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", config["port"]), handler_for(service))
    except OSError as exc:
        raise RuntimeError(f'Cannot listen on 127.0.0.1:{config["port"]}: {exc}. If this tool is already running, use its existing service; otherwise choose another --port.') from exc
    config["port"] = server.server_address[1]
    service.info = service_info(config, token)
    try:
        if not args.serve or not (output / "index.html").exists():
            Builder(config, service.progress).build(service.info)
        else:
            atomic_write(output / "indexes.js", indexes_script(discover_indexes(output), service.info))
        atomic_write(runtime_path, json.dumps({"token": token, "url": service.info["url"], "pid": os.getpid()}, ensure_ascii=False))
        print("\nCollection Tree service: " + service.info["url"] + "/\nKeep this window running to use the HTML Rebuild button. Press Ctrl+C to stop.", flush=True)
        if not args.no_browser:
            webbrowser.open(service.info["url"] + "/")
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        print("\nService stopped. HTML remains available offline.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print("Error: " + str(error), file=sys.stderr)
        raise SystemExit(1)
