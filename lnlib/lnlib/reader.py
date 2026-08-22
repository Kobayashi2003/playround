"""Reading a book in the browser, standard library only.

Three shapes of book are readable, and the front end treats each differently:

  epub          a zip of XHTML. The spine is served as a virtual directory so
                the relative links, CSS and images inside the book resolve
                unchanged in an iframe -- including vertical writing and
                right-to-left page progression, which browsers already do.
  cbz / folder  an ordered list of images, shown one page at a time.
  pdf           handed to the built-in PDF viewer of the browser as-is.

Anything else (.azw3, .mobi, .cbr) has no in-browser renderer here; the UI
offers to open it in the desktop application instead. A .txt is a placeholder
for a volume that is not owned, so there is nothing to read.
"""
from __future__ import annotations

import os
import posixpath
import re
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile

from . import db
from .config import IMAGE_EXT

TEXT_MIME = {
    ".xhtml": "application/xhtml+xml", ".html": "text/html", ".htm": "text/html",
    ".css": "text/css", ".js": "text/javascript", ".xml": "application/xml",
    ".ncx": "application/x-dtbncx+xml", ".opf": "application/oebps-package+xml",
    ".txt": "text/plain",
}
BINARY_MIME = {
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
    ".otf": "font/otf", ".ttf": "font/ttf", ".woff": "font/woff",
    ".woff2": "font/woff2", ".pdf": "application/pdf",
}
READABLE_ZIP = {".epub", ".cbz"}


def mime_for(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    if ext in TEXT_MIME:
        return TEXT_MIME[ext] + "; charset=utf-8"
    return BINARY_MIME.get(ext, "application/octet-stream")


# --------------------------------------------------------------------- epub
def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _opf_path(z: zipfile.ZipFile) -> str | None:
    try:
        container = z.read("META-INF/container.xml").decode("utf-8", "replace")
    except KeyError:
        container = ""
    m = re.search(r'full-path="([^"]+)"', container)
    if m:
        return m.group(1)
    return next((n for n in z.namelist() if n.lower().endswith(".opf")), None)


def _resolve(base: str, href: str) -> str:
    """Join an href to the OPF directory, dropping any fragment."""
    href = urllib.parse.unquote(href.split("#", 1)[0])
    return posixpath.normpath(posixpath.join(base, href)) if base else href


def _epub_manifest(path: str) -> dict:
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        opf_name = _opf_path(z)
        if not opf_name:
            raise ValueError("no OPF in this epub")
        base = posixpath.dirname(opf_name)
        root = ET.fromstring(z.read(opf_name))

        meta = {"title": None, "author": None, "language": None,
                "direction": "ltr", "layout": "reflowable"}
        manifest: dict[str, dict] = {}
        spine: list[dict] = []
        ncx_id = None

        for node in root.iter():
            tag = _localname(node.tag)
            if tag == "title" and not meta["title"]:
                meta["title"] = (node.text or "").strip() or None
            elif tag == "creator" and not meta["author"]:
                meta["author"] = (node.text or "").strip() or None
            elif tag == "language" and not meta["language"]:
                meta["language"] = (node.text or "").strip() or None
            elif tag == "meta":
                prop = (node.get("property") or node.get("name") or "").lower()
                val = (node.get("content") or node.text or "").strip().lower()
                if prop.endswith("rendition:layout") and val:
                    meta["layout"] = val
            elif tag == "item":
                iid, href = node.get("id"), node.get("href")
                if iid and href:
                    manifest[iid] = {
                        "href": _resolve(base, href),
                        "type": node.get("media-type") or "",
                        "props": node.get("properties") or "",
                    }
            elif tag == "spine":
                ncx_id = node.get("toc")
                if (node.get("page-progression-direction") or "").lower() == "rtl":
                    meta["direction"] = "rtl"
            elif tag == "itemref":
                iid = node.get("idref")
                if iid:
                    spine.append({"id": iid,
                                  "linear": (node.get("linear") or "yes") != "no"})

        sections = []
        for ref in spine:
            item = manifest.get(ref["id"])
            if not item or item["href"] not in names:
                continue
            sections.append({"href": item["href"], "title": None,
                             "linear": ref["linear"]})
        if not sections:                    # malformed spine: fall back to order
            sections = [{"href": i["href"], "title": None, "linear": True}
                        for i in manifest.values()
                        if "html" in i["type"] and i["href"] in names]

        toc = _epub_toc(z, manifest, ncx_id, names)

    # Give each spine entry the table-of-contents label that points at it.
    by_href: dict[str, str] = {}
    for t in toc:
        by_href.setdefault(t["href"], t["label"])
    for i, s in enumerate(sections):
        s["title"] = by_href.get(s["href"]) or str(i + 1)
    return {"kind": "epub", "meta": meta, "sections": sections, "toc": toc}


def _epub_toc(z: zipfile.ZipFile, manifest: dict, ncx_id: str | None,
              names: set) -> list[dict]:
    nav = next((i for i in manifest.values() if "nav" in i["props"].split()), None)
    if nav and nav["href"] in names:
        got = _parse_nav(z.read(nav["href"]), posixpath.dirname(nav["href"]))
        if got:
            return got
    ncx = manifest.get(ncx_id) if ncx_id else None
    if not ncx:
        ncx = next((i for i in manifest.values()
                    if i["href"].lower().endswith(".ncx")), None)
    if ncx and ncx["href"] in names:
        return _parse_ncx(z.read(ncx["href"]), posixpath.dirname(ncx["href"]))
    return []


def _parse_nav(data: bytes, base: str) -> list[dict]:
    """EPUB3 navigation document: the ordered list inside nav[type=toc]."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return []
    navs = [n for n in root.iter() if _localname(n.tag) == "nav"]
    chosen = None
    for n in navs:
        types = " ".join(v for k, v in n.attrib.items() if k.endswith("type"))
        if "toc" in types:
            chosen = n
            break
    chosen = chosen or (navs[0] if navs else None)
    if chosen is None:
        return []

    out: list[dict] = []

    def walk(node, depth):
        for child in node:
            name = _localname(child.tag)
            if name == "li":
                a = next((e for e in child.iter()
                          if _localname(e.tag) == "a" and e.get("href")), None)
                if a is not None:
                    out.append({"href": _resolve(base, a.get("href")),
                                "label": "".join(a.itertext()).strip() or "-",
                                "depth": depth})
                for sub in child:
                    if _localname(sub.tag) in ("ol", "ul"):
                        walk(sub, depth + 1)
            elif name in ("ol", "ul"):
                walk(child, depth)

    walk(chosen, 0)
    return out


def _parse_ncx(data: bytes, base: str) -> list[dict]:
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        return []
    out: list[dict] = []

    def walk(node, depth):
        for child in node:
            if _localname(child.tag) != "navPoint":
                continue
            label = next((e for e in child.iter()
                          if _localname(e.tag) == "text"), None)
            src = next((e for e in child.iter()
                        if _localname(e.tag) == "content" and e.get("src")), None)
            if src is not None:
                text = (label.text or "").strip() if label is not None else ""
                out.append({"href": _resolve(base, src.get("src")),
                            "label": text or "-", "depth": depth})
            walk(child, depth + 1)

    nav_map = next((n for n in root.iter() if _localname(n.tag) == "navMap"), root)
    walk(nav_map, 0)
    return out


# ------------------------------------------------------------------- images
def _cbz_manifest(path: str) -> dict:
    with zipfile.ZipFile(path) as z:
        pages = sorted(
            (n for n in z.namelist()
             if os.path.splitext(n)[1].lower() in IMAGE_EXT
             and not n.endswith("/") and "__MACOSX" not in n),
            key=lambda n: (len(posixpath.dirname(n)), n.lower()))
    return {"kind": "images", "pages": pages, "meta": {"direction": "rtl"}}


def _folder_manifest(path: str) -> dict:
    try:
        names = os.listdir(path)
    except OSError as e:
        raise ValueError(str(e)) from e
    pages = sorted((n for n in names
                    if os.path.splitext(n)[1].lower() in IMAGE_EXT),
                   key=str.lower)
    return {"kind": "images", "pages": pages, "meta": {"direction": "rtl"}}


# -------------------------------------------------------------------- entry
def manifest(item_id: int) -> dict:
    """Everything the front end needs in order to open one book."""
    with db.connect() as conn:
        row = conn.execute(
            "SELECT i.*, s.title series_title, s.author, s.id series_id, "
            "s.root_kind FROM items i JOIN series s ON s.id=i.series_id "
            "WHERE i.id=?", (item_id,)).fetchone()
    if not row:
        return {"error": "no such item"}
    item = dict(row)
    path, ext = item["path"], (item["ext"] or "").lower()

    out = {"item": {k: item[k] for k in
                    ("id", "title", "filename", "ext", "date", "volume", "size",
                     "series_id", "series_title", "author", "root_kind", "path")},
           "progress": progress_for(path)}

    if item["is_missing"]:
        return {**out, "kind": "missing", "detail": "未所持のプレースホルダです"}
    if not os.path.exists(path):
        return {**out, "kind": "gone", "detail": "ファイルが見つかりません"}

    try:
        if item["is_dir"]:
            body = _folder_manifest(path)
        elif ext == ".epub":
            body = _epub_manifest(path)
        elif ext == ".cbz":
            body = _cbz_manifest(path)
        elif ext == ".pdf":
            body = {"kind": "pdf", "meta": {}}
        else:
            return {**out, "kind": "external",
                    "detail": f"{ext} はブラウザでは開けません"}
    except (zipfile.BadZipFile, ET.ParseError, ValueError, OSError) as e:
        return {**out, "kind": "error", "detail": f"{type(e).__name__}: {e}"}

    if body["kind"] == "images" and not body["pages"]:
        return {**out, "kind": "error", "detail": "画像が見つかりません"}
    if body["kind"] == "epub" and not body["sections"]:
        return {**out, "kind": "error", "detail": "本文が見つかりません"}
    return {**out, **body}


def resource(item_id: int, rel: str) -> tuple[bytes, str]:
    """One file from inside a book. Raises KeyError / FileNotFoundError."""
    with db.connect() as conn:
        row = conn.execute("SELECT path, ext, is_dir, is_missing FROM items "
                           "WHERE id=?", (item_id,)).fetchone()
    if not row or row["is_missing"]:
        raise KeyError("no such book")
    path, ext = row["path"], (row["ext"] or "").lower()
    rel = urllib.parse.unquote(rel).lstrip("/")

    if row["is_dir"]:
        safe = posixpath.normpath(rel)
        if safe.startswith("..") or ":" in safe or posixpath.isabs(safe):
            raise KeyError("forbidden")
        full = os.path.join(path, safe.replace("/", os.sep))
        if not os.path.isfile(full):
            raise FileNotFoundError(rel)
        with open(full, "rb") as fh:
            return fh.read(), mime_for(full)

    if ext not in READABLE_ZIP:
        raise KeyError(f"{ext} has no inner files")

    with zipfile.ZipFile(path) as z:
        want = posixpath.normpath(rel)
        try:
            return z.read(want), mime_for(want)
        except KeyError:
            pass
        hit = {n.lower(): n for n in z.namelist()}.get(want.lower())
        if hit is None:
            raise FileNotFoundError(rel)
        return z.read(hit), mime_for(hit)


def whole_file(item_id: int) -> tuple[str, str]:
    """Path and mime of the book itself -- used to hand a PDF to the browser."""
    with db.connect() as conn:
        row = conn.execute("SELECT path, ext, is_missing, is_dir FROM items "
                           "WHERE id=?", (item_id,)).fetchone()
    if not row or row["is_missing"] or row["is_dir"]:
        raise KeyError("not a single-file book")
    if not os.path.isfile(row["path"]):
        raise FileNotFoundError(row["path"])
    return row["path"], mime_for(row["path"])


# ----------------------------------------------------------------- progress
def progress_for(path: str) -> dict | None:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM reading WHERE path=?", (path,)).fetchone()
    return dict(row) if row else None


def save_progress(item_id: int, locator: str | None, position: float,
                  percent: float, finished: bool = False) -> dict:
    with db.connect() as conn:
        row = conn.execute("SELECT path FROM items WHERE id=?", (item_id,)).fetchone()
        if not row:
            return {"ok": False, "reason": "no such item"}
        conn.execute(
            "INSERT INTO reading(path,locator,position,percent,finished,updated_at) "
            "VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET "
            "locator=excluded.locator, position=excluded.position, "
            "percent=excluded.percent, finished=excluded.finished, "
            "updated_at=excluded.updated_at",
            (row["path"], locator, float(position), float(percent),
             int(bool(finished)), db.now()))
    return {"ok": True}


def clear_progress(item_id: int) -> dict:
    with db.connect() as conn:
        row = conn.execute("SELECT path FROM items WHERE id=?", (item_id,)).fetchone()
        if not row:
            return {"ok": False, "reason": "no such item"}
        conn.execute("DELETE FROM reading WHERE path=?", (row["path"],))
    return {"ok": True}


def recent(limit: int = 60) -> list[dict]:
    """Books with reading progress, most recently opened first."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT r.locator, r.percent, r.finished, r.updated_at, "
            "i.id item_id, i.title, i.ext, i.volume, i.date, "
            "s.id series_id, s.title series_title, s.author "
            "FROM reading r JOIN items i ON i.path=r.path "
            "JOIN series s ON s.id=i.series_id "
            "ORDER BY r.updated_at DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]
