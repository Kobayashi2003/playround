"""Cover extraction, standard library only.

Images are copied out byte-for-byte and cached on disk; nothing is decoded or
re-encoded, so no imaging library is needed. Per format:

  .epub        read the OPF, follow <meta name="cover">, else the first sizable
               image in manifest order
  .cbz         first image by filename order
  image folder first image by filename order
  .pdf         first sufficiently large embedded JPEG (DCTDecode streams)
  .azw3/.mobi  first sufficiently large embedded JPEG in the record area
  .txt         plain text, so there is no image inside it to copy out
"""
from __future__ import annotations

import hashlib
import os
import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile

from . import config
from .config import IMAGE_EXT

MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif"}

MIN_IMAGE_BYTES = 6 * 1024        # skip icons, rules, publisher logos


def _cache_name(path: str, ext: str) -> str:
    h = hashlib.sha1(path.encode("utf-8", "surrogatepass")).hexdigest()
    return h + ext


def _write_cache(data: bytes, path: str, ext: str) -> str:
    config.ensure_dirs()
    name = _cache_name(path, ext)
    dest = os.path.join(config.CACHE_DIR, name)
    tmp = dest + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, dest)
    return name


def _cached(path: str) -> tuple[str, str] | None:
    """An extraction done earlier and still valid.

    The cached images are named after the file they came from rather than after
    a row, so they outlive the covers table however it is rebuilt -- including
    a root removed and added back. Reusing them turns a rescan from a walk
    through several thousand epubs into a few thousand stat calls.
    """
    h = hashlib.sha1(path.encode("utf-8", "surrogatepass")).hexdigest()
    try:
        source_mtime = os.path.getmtime(path)
    except OSError:
        return None
    for ext, mime in MIME.items():
        full = os.path.join(config.CACHE_DIR, h + ext)
        try:
            if os.stat(full).st_mtime >= source_mtime:
                return h + ext, mime
        except OSError:
            continue
    return None


def _sorted_images(names: list[str]) -> list[str]:
    imgs = [n for n in names if os.path.splitext(n)[1].lower() in IMAGE_EXT]
    return sorted(imgs, key=lambda n: (len(os.path.dirname(n)), n.lower()))


# --------------------------------------------------------------------- epub
def _epub_cover(path: str) -> tuple[bytes, str] | None:
    with zipfile.ZipFile(path) as z:
        names = z.namelist()

        opf_name = None
        try:
            container = z.read("META-INF/container.xml").decode("utf-8", "replace")
            m = re.search(r'full-path="([^"]+)"', container)
            if m:
                opf_name = m.group(1)
        except KeyError:
            pass
        if not opf_name:
            opf_name = next((n for n in names if n.lower().endswith(".opf")), None)
        if not opf_name:
            return _zip_first_image(z, names)

        base = posixpath.dirname(opf_name)
        try:
            root = ET.fromstring(z.read(opf_name))
        except (KeyError, ET.ParseError):
            return _zip_first_image(z, names)

        ns = {"opf": "http://www.idpf.org/2007/opf"}
        manifest = {}
        for item in root.iter():
            if not item.tag.endswith("}item") and item.tag != "item":
                continue
            iid = item.get("id")
            href = item.get("href")
            if iid and href:
                manifest[iid] = (href, item.get("media-type") or "",
                                 item.get("properties") or "")

        candidates: list[str] = []

        # 1. <meta name="cover" content="cover-image-id"/>
        for meta in root.iter():
            if meta.tag.endswith("}meta") or meta.tag == "meta":
                if (meta.get("name") or "").lower() == "cover":
                    cid = meta.get("content")
                    if cid and cid in manifest:
                        candidates.append(manifest[cid][0])
        # 2. EPUB3 properties="cover-image"
        for href, mtype, props in manifest.values():
            if "cover-image" in props:
                candidates.append(href)
        # 3. anything that calls itself a cover
        for href, mtype, props in manifest.values():
            if mtype.startswith("image/") and "cover" in href.lower():
                candidates.append(href)
        # 4. first image in manifest order
        for href, mtype, props in manifest.values():
            if mtype.startswith("image/"):
                candidates.append(href)

        seen = set()
        for href in candidates:
            full = posixpath.normpath(posixpath.join(base, href)) if base else href
            if full in seen:
                continue
            seen.add(full)
            for cand in (full, href):
                try:
                    data = z.read(cand)
                except KeyError:
                    continue
                if len(data) >= MIN_IMAGE_BYTES:
                    return data, os.path.splitext(cand)[1].lower() or ".jpg"
        return _zip_first_image(z, names)


def _zip_first_image(z: zipfile.ZipFile, names: list[str]) -> tuple[bytes, str] | None:
    for n in _sorted_images(names):
        try:
            data = z.read(n)
        except KeyError:
            continue
        if len(data) >= MIN_IMAGE_BYTES:
            return data, os.path.splitext(n)[1].lower()
    return None


def _cbz_cover(path: str) -> tuple[bytes, str] | None:
    with zipfile.ZipFile(path) as z:
        return _zip_first_image(z, z.namelist())


def _folder_cover(path: str) -> tuple[bytes, str] | None:
    try:
        names = sorted(os.listdir(path), key=str.lower)
    except OSError:
        return None
    for n in names:
        if os.path.splitext(n)[1].lower() not in IMAGE_EXT:
            continue
        full = os.path.join(path, n)
        try:
            if os.path.getsize(full) < MIN_IMAGE_BYTES:
                continue
            with open(full, "rb") as fh:
                return fh.read(), os.path.splitext(n)[1].lower()
        except OSError:
            continue
    return None


# ------------------------------------------------------- raw JPEG scavenging
def _scan_jpeg(path: str, limit: int) -> tuple[bytes, str] | None:
    """Pull the first reasonably large JPEG out of an arbitrary container.

    Used for PDF and MOBI/KF8, where a real parser would be a project of its
    own. Cover images sit near the front of both formats, so reading a bounded
    prefix is enough and keeps this cheap.
    """
    try:
        with open(path, "rb") as fh:
            blob = fh.read(limit)
    except OSError:
        return None
    pos = 0
    best = None
    while True:
        start = blob.find(b"\xff\xd8\xff", pos)
        if start < 0:
            break
        end = blob.find(b"\xff\xd9", start + 3)
        if end < 0:
            break
        data = blob[start:end + 2]
        pos = end + 2
        if len(data) >= MIN_IMAGE_BYTES:
            if best is None or len(data) > len(best):
                best = data
            # the first big one is nearly always the cover
            if len(data) > 40 * 1024:
                return data, ".jpg"
    return (best, ".jpg") if best else None


EXTRACTORS = {
    ".epub": _epub_cover,
    ".cbz": _cbz_cover,
    ".zip": _cbz_cover,           # the same thing, under its ordinary name
    ".pdf": lambda p: _scan_jpeg(p, 12 * 1024 * 1024),
    ".azw3": lambda p: _scan_jpeg(p, 12 * 1024 * 1024),
    ".mobi": lambda p: _scan_jpeg(p, 12 * 1024 * 1024),
}


def extract(path: str, ext: str, is_dir: bool, reuse: bool = True) -> dict:
    """-> {state, cache_name, mime, source, detail}"""
    if reuse:
        got = _cached(path)
        if got:
            return dict(state="ok", source="cache", detail=None,
                        cache_name=got[0], mime=got[1])
    if is_dir:
        fn, source = _folder_cover, "folder-first"
    else:
        ext = ext.lower()
        fn = EXTRACTORS.get(ext)
        source = {".epub": "epub-opf", ".cbz": "zip-first", ".zip": "zip-first",
                  ".pdf": "pdf-jpeg",
                  ".azw3": "mobi-jpeg", ".mobi": "mobi-jpeg"}.get(ext, "none")
        if fn is None:
            return dict(state="none", source="none",
                        detail=f"no extractor for {ext}", cache_name=None, mime=None)
    try:
        got = fn(path)
    except (zipfile.BadZipFile, OSError, ValueError) as e:
        return dict(state="error", source=source, detail=str(e)[:200],
                    cache_name=None, mime=None)
    if not got:
        return dict(state="none", source=source, detail="no image found",
                    cache_name=None, mime=None)
    data, iext = got
    if iext not in MIME:
        iext = ".jpg"
    name = _write_cache(data, path, iext)
    return dict(state="ok", source=source, detail=None,
                cache_name=name, mime=MIME[iext])
