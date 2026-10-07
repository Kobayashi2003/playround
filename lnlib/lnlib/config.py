"""Configuration: library roots and cache locations.

Everything lives in one JSON file next to the package so the whole project can
be copied or version-controlled as a unit.
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field, fields as dataclass_fields

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(PROJECT_DIR, "config.json")
DATA_DIR = os.path.join(PROJECT_DIR, "data")
CACHE_DIR = os.path.join(DATA_DIR, "covers")
DB_PATH = os.path.join(DATA_DIR, "library.db")

BOOK_EXT = {".epub", ".azw3", ".mobi", ".pdf", ".cbz", ".cbr", ".txt",
            # Comic archives under their ordinary names. A .zip is read exactly
            # like a .cbz, which is all a .cbz is; the rest are recorded and
            # counted but opened in the desktop app, as a .cbr always was.
            ".zip", ".rar", ".7z", ".tar"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}

# How the top level of a root is laid out. Everything below it is walked the
# same way whichever this is.
#
#   shelves   folders directly under the root are shelves (1. 連載中, EPUB …);
#             the default, and what a root with no setting means
#   authors   folders directly under the root are authors, the way a Calibre
#             export is laid out: Author/Title - Author.epub. The root is one
#             shelf, and each folder's name is the credit for what is inside it
LAYOUTS = ("shelves", "authors")


def format_of(ext: str, is_dir: bool = False) -> str:
    """What kind of file this is, as one lowercase word.

    The extension is the answer, minus its dot; a folder of page scans is
    `images`. Nothing is mapped or grouped, so a format that turns up in the
    collection tomorrow counts itself without being added here first.
    """
    if is_dir or ext == "<dir>":
        return "images"
    return (ext or "").lstrip(".").lower() or "other"

# A fresh checkout starts with no roots: which folders a library lives in is
# this machine's business, not the repository's. `config --add-root` adds them,
# and config.example.json shows what the file looks like.
DEFAULT_ROOTS: list[dict] = []


@dataclass
class Root:
    path: str
    label: str
    kind: str = "novel"
    enabled: bool = True
    layout: str = "shelves"

    @staticmethod
    def of(raw: dict) -> "Root":
        """Build from JSON, ignoring keys this version no longer knows about.

        `has_shelves` used to live here. Shelves are now recognised by looking
        at the folder names, so a root can hold shelves and loose books at once
        and nothing has to be reconfigured when the layout changes.
        """
        fields = {f.name for f in dataclass_fields(Root)}
        return Root(**{k: v for k, v in raw.items() if k in fields})


@dataclass
class Config:
    roots: list[Root] = field(default_factory=list)
    host: str = "127.0.0.1"
    port: int = 16020
    # Path prefix to serve under, "" for the origin root. Only needed behind a
    # shared edge, where one public port fronts several apps and the root belongs
    # to none of them. `serve --base-path` overrides it for one run.
    base_path: str = ""
    theme: str = "auto"          # auto | dark | light

    @staticmethod
    def load() -> "Config":
        if not os.path.exists(CONFIG_PATH):
            cfg = Config(roots=[Root.of(r) for r in DEFAULT_ROOTS])
            cfg.save()
            return cfg
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            raw = json.load(fh)
        roots = [Root.of(r) for r in raw.get("roots", [])]
        return Config(
            roots=roots,
            host=raw.get("host", "127.0.0.1"),
            port=int(raw.get("port", 16020)),
            base_path=raw.get("base_path", ""),
            theme=raw.get("theme", "auto"),
        )

    def save(self) -> None:
        os.makedirs(PROJECT_DIR, exist_ok=True)
        payload = {
            "roots": [asdict(r) for r in self.roots],
            "host": self.host,
            "port": self.port,
            "base_path": self.base_path,
            "theme": self.theme,
        }
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")          # it is a text file; it ends with a newline
        os.replace(tmp, CONFIG_PATH)

    def enabled_roots(self) -> list[Root]:
        return [r for r in self.roots if r.enabled and os.path.isdir(r.path)]


def ensure_dirs() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(CACHE_DIR, exist_ok=True)
