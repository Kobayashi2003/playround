"""Move a session to another working folder.

Each tool finds a session to resume by the folder it was started in, so moving one
means rewriting the folder recorded in its log. Claude Code also files a log under
`~/.claude/projects/<encoded folder>/`, and Codex keeps a thread table in
`~/.codex/state_*.sqlite`; both follow the log. Only folder fields are rewritten,
never message content, and the original log is copied to a backup first.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
from collections.abc import Callable
from pathlib import Path

import parsers

# Codex stores some folders in Win32 extended-length form.
LONG_PREFIX = "\\\\?\\"

# Claude Code shortens longer project names with a hash this module does not reproduce.
MAX_PROJECT_NAME = 200


class RelocateError(Exception):
    pass


def _norm(p: str) -> str:
    if p.startswith(LONG_PREFIX):
        p = p[len(LONG_PREFIX) :]
    return os.path.normcase(os.path.normpath(p))


def same_folder(a: str, b: str) -> bool:
    return _norm(a) == _norm(b)


def remap(value: str, old: str, new: str) -> str | None:
    """`value` with folder `old` (or a parent of it) replaced by `new`; None if outside `old`."""
    prefix = LONG_PREFIX if value.startswith(LONG_PREFIX) else ""
    raw = os.path.normpath(value[len(prefix) :])
    base = _norm(old).rstrip(os.sep)
    low = os.path.normcase(raw)
    if low == base or low == base + os.sep:
        return prefix + new
    if not low.startswith(base + os.sep):
        return None
    # normcase keeps the length, so the tail can be cut from the original spelling.
    return prefix + new.rstrip("\\/") + os.sep + raw[len(base) + 1 :]


def claude_project_dir(cwd: str) -> Path:
    name = re.sub(r"[^A-Za-z0-9]", "-", cwd)
    if len(name) > MAX_PROJECT_NAME:
        raise RelocateError("folder path too long for a Claude Code project name")
    return parsers.CLAUDE_DIR / name


def _rewrite(path: Path, fix: Callable[[dict[str, object]], bool]) -> str:
    """The log's text with `fix` applied to every record; untouched lines stay byte-identical."""
    out: list[str] = []
    # Strict decoding: a log that is not valid UTF-8 is refused rather than re-encoded.
    with open(path, encoding="utf-8", newline="") as fh:
        for line in fh:
            body = line.rstrip("\r\n")
            try:
                rec = json.loads(body) if body.startswith("{") else None
            except ValueError:
                rec = None
            if isinstance(rec, dict) and fix(rec):
                dumped = json.dumps(rec, ensure_ascii=False, separators=(",", ":"))
                out.append(dumped + line[len(body) :])
            else:
                out.append(line)
    return "".join(out)


def _write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".relocate.tmp")
    tmp.write_text(text, encoding="utf-8", newline="")
    tmp.replace(path)


def _backup(path: Path, backup_dir: Path) -> None:
    backup_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, backup_dir / path.name)


def move_claude(path: Path, old: str, new: str, backup_dir: Path) -> Path:
    """Rewrite the top-level `cwd` of every record and refile the log. -> its new path."""

    def fix(rec: dict[str, object]) -> bool:
        cwd = rec.get("cwd")
        moved = remap(cwd, old, new) if isinstance(cwd, str) else None
        if moved is None or moved == cwd:
            return False
        rec["cwd"] = moved
        return True

    dest_dir = claude_project_dir(new)
    dest = dest_dir / path.name
    # Tool output too large for the log is kept in a folder named after the session.
    side, side_dest = path.with_suffix(""), dest.with_suffix("")
    same_place = os.path.normcase(str(dest)) == os.path.normcase(str(path))
    if not same_place and (dest.exists() or (side.is_dir() and side_dest.exists())):
        raise RelocateError(f"{dest} already exists")

    text = _rewrite(path, fix)
    _backup(path, backup_dir)
    if same_place:
        _write(path, text)
        return path
    dest_dir.mkdir(parents=True, exist_ok=True)
    _write(dest, text)
    if side.is_dir():
        shutil.move(str(side), str(side_dest))
    path.unlink()
    return dest


def _codex_fix(old: str, new: str) -> Callable[[dict[str, object]], bool]:
    def walk(node: object) -> bool:
        changed = False
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "cwd" and isinstance(v, str):
                    moved = remap(v, old, new)
                    if moved is not None and moved != v:
                        node[k] = moved
                        changed = True
                elif k == "runtime_workspace_roots" and isinstance(v, list):
                    for i, root in enumerate(v):
                        moved = remap(root, old, new) if isinstance(root, str) else None
                        if moved is not None and moved != root:
                            v[i] = moved
                            changed = True
                else:
                    changed = walk(v) or changed
        elif isinstance(node, list):
            for v in node:
                changed = walk(v) or changed
        return changed

    return walk


def codex_state_db() -> Path | None:
    def version(p: Path) -> int:
        m = re.fullmatch(r"state_(\d+)\.sqlite", p.name)
        return int(m.group(1)) if m else -1

    dbs = [p for p in (parsers.HOME / ".codex").glob("state_*.sqlite") if version(p) >= 0]
    return max(dbs, key=version) if dbs else None


def move_codex(path: Path, old: str, new: str, thread_id: str, backup_dir: Path) -> list[str]:
    """Rewrite the folder fields in place and in Codex's thread table. -> warnings."""
    text = _rewrite(path, _codex_fix(old, new))
    _backup(path, backup_dir)
    _write(path, text)

    db = codex_state_db()
    if db is None:
        return []
    try:
        con = sqlite3.connect(db, timeout=5)
        try:
            with con:
                row = con.execute("SELECT cwd FROM threads WHERE id = ?", (thread_id,)).fetchone()
                moved = remap(row[0], old, new) if row else None
                if moved is not None:
                    con.execute("UPDATE threads SET cwd = ? WHERE id = ?", (moved, thread_id))
        finally:
            con.close()
    except sqlite3.Error as exc:
        return [f"log rewritten, but Codex's thread table was not updated: {exc}"]
    return []
