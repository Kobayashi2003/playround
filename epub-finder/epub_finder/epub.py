"""Read text chapters in an EPUB's declared reading order."""

from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
import posixpath
import re
from urllib.parse import unquote
import xml.etree.ElementTree as ET
from zipfile import BadZipFile, ZipFile


MAX_MEMBER_BYTES = 25 * 1024 * 1024
SPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class Chapter:
    number: int
    title: str
    href: str
    paragraphs: list[str]


@dataclass(frozen=True)
class Book:
    title: str
    author: str
    chapters: list[Chapter]


def _name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _member(zip_file: ZipFile, name: str) -> bytes:
    info = zip_file.getinfo(name)
    if info.file_size > MAX_MEMBER_BYTES:
        raise ValueError(f"EPUB content file is too large: {name}")
    return zip_file.read(info)


class _TextExtractor(HTMLParser):
    BLOCKS = {"p", "div", "section", "article", "blockquote", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr"}
    SKIP = {"script", "style", "svg", "head"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.headings: list[str] = []
        self._heading: list[str] | None = None
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in self.SKIP:
            self._skip_depth += 1
        if self._skip_depth:
            return
        if tag in self.BLOCKS or tag == "br":
            self.parts.append("\n")
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._heading = []

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in self.SKIP:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"} and self._heading is not None:
            heading = SPACE.sub(" ", "".join(self._heading)).strip()
            if heading:
                self.headings.append(heading)
            self._heading = None
        if tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip_depth:
            self.parts.append(SPACE.sub(" ", data))
            if self._heading is not None:
                self._heading.append(data)

    def paragraphs(self) -> list[str]:
        return [clean for line in "".join(self.parts).splitlines() if (clean := SPACE.sub(" ", line).strip())]


def read_epub(path: Path) -> Book:
    try:
        with ZipFile(path) as archive:
            container = ET.fromstring(_member(archive, "META-INF/container.xml"))
            rootfile = next((e.attrib.get("full-path") for e in container.iter() if _name(e.tag) == "rootfile"), None)
            if not rootfile:
                raise ValueError("EPUB package document is missing")
            opf = ET.fromstring(_member(archive, rootfile))
            title = next(("".join(e.itertext()).strip() for e in opf.iter() if _name(e.tag) == "title"), "") or path.stem
            author = next(("".join(e.itertext()).strip() for e in opf.iter() if _name(e.tag) == "creator"), "")
            manifest = {
                e.attrib["id"]: e.attrib
                for e in opf.iter()
                if _name(e.tag) == "item" and "id" in e.attrib
            }
            spine = [e.attrib.get("idref", "") for e in opf.iter() if _name(e.tag) == "itemref"]
            base = posixpath.dirname(rootfile)
            chapters: list[Chapter] = []
            for item_id in spine:
                item = manifest.get(item_id)
                if not item or "nav" in item.get("properties", "").split():
                    continue
                if item.get("media-type") not in {"application/xhtml+xml", "text/html"}:
                    continue
                href = unquote(item.get("href", "").split("#", 1)[0])
                member_name = posixpath.normpath(posixpath.join(base, href))
                if member_name.startswith("../") or member_name.startswith("/"):
                    continue
                html = _member(archive, member_name).decode("utf-8-sig", errors="replace")
                extractor = _TextExtractor()
                extractor.feed(html)
                paragraphs = extractor.paragraphs()
                if paragraphs:
                    chapter_title = extractor.headings[0] if extractor.headings else Path(href).stem
                    chapters.append(Chapter(len(chapters) + 1, chapter_title, member_name, paragraphs))
            return Book(title, author, chapters)
    except (BadZipFile, KeyError, ET.ParseError) as exc:
        raise ValueError(f"Cannot read EPUB: {exc}") from exc
