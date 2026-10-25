import json
import sqlite3
from pathlib import Path

import pytest

import parsers
import relocate

OLD = "D:\\Work\\old"
NEW = "D:\\Work\\new"


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(parsers, "HOME", tmp_path)
    monkeypatch.setattr(parsers, "CLAUDE_DIR", tmp_path / ".claude" / "projects")
    return tmp_path


def write_log(path: Path, records: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")


def read_log(path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


@pytest.mark.skipif(not relocate.os.name == "nt", reason="Windows path semantics")
class TestRemap:
    def test_same_folder_any_case(self) -> None:
        assert relocate.remap("d:\\work\\OLD", OLD, NEW) == NEW

    def test_subfolder_keeps_its_tail(self) -> None:
        assert relocate.remap("D:\\Work\\old\\src\\App", OLD, NEW) == "D:\\Work\\new\\src\\App"

    def test_sibling_with_shared_prefix_is_outside(self) -> None:
        assert relocate.remap("D:\\Work\\older", OLD, NEW) is None

    def test_extended_length_prefix_is_kept(self) -> None:
        assert relocate.remap("\\\\?\\D:\\Work\\old", OLD, NEW) == "\\\\?\\" + NEW


def test_project_dir_name(home: Path) -> None:
    assert relocate.claude_project_dir("D:\\Program\\Code").name == "D--Program-Code"


@pytest.mark.skipif(not relocate.os.name == "nt", reason="Windows path semantics")
def test_move_claude_refiles_log_and_sidecar(home: Path, tmp_path: Path) -> None:
    src = relocate.claude_project_dir(OLD) / "abc.jsonl"
    untouched = '{"type":"mode","mode":"normal"}'
    write_log(
        src,
        [
            {"type": "user", "cwd": OLD, "message": {"content": f"look in {OLD}"}},
            {"type": "assistant", "cwd": OLD + "\\sub"},
            {"type": "system", "cwd": "D:\\Elsewhere"},
        ],
    )
    src.write_text(untouched + "\n" + src.read_text(encoding="utf-8"), encoding="utf-8")
    (src.with_suffix("") / "tool-results").mkdir(parents=True)

    dest = relocate.move_claude(src, OLD, NEW, tmp_path / "backup")

    assert dest == relocate.claude_project_dir(NEW) / "abc.jsonl"
    assert not src.exists() and not src.with_suffix("").exists()
    assert (dest.with_suffix("") / "tool-results").is_dir()
    assert dest.read_text(encoding="utf-8").splitlines()[0] == untouched
    recs = read_log(dest)[1:]
    assert [r["cwd"] for r in recs] == [NEW, NEW + "\\sub", "D:\\Elsewhere"]
    # Message text that mentions the folder is content, not a folder field.
    assert recs[0]["message"] == {"content": f"look in {OLD}"}
    assert read_log(tmp_path / "backup" / "abc.jsonl")[1]["cwd"] == OLD


def test_move_claude_refuses_to_overwrite(home: Path, tmp_path: Path) -> None:
    src = relocate.claude_project_dir(OLD) / "abc.jsonl"
    write_log(src, [{"type": "user", "cwd": OLD}])
    write_log(relocate.claude_project_dir(NEW) / "abc.jsonl", [{"type": "user", "cwd": NEW}])
    with pytest.raises(relocate.RelocateError):
        relocate.move_claude(src, OLD, NEW, tmp_path / "backup")
    assert src.exists()


@pytest.mark.skipif(not relocate.os.name == "nt", reason="Windows path semantics")
def test_move_codex_rewrites_log_and_thread_table(home: Path, tmp_path: Path) -> None:
    log = home / ".codex" / "sessions" / "rollout-x.jsonl"
    write_log(
        log,
        [
            {
                "type": "session_meta",
                "payload": {"id": "t1", "cwd": OLD, "runtime_workspace_roots": [OLD]},
            },
            {"type": "turn_context", "payload": {"cwd": OLD + "\\pkg"}},
        ],
    )
    db = home / ".codex" / "state_5.sqlite"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL)")
    con.execute("INSERT INTO threads VALUES ('t1', ?)", ("\\\\?\\" + OLD,))
    con.commit()
    con.close()

    assert relocate.move_codex(log, OLD, NEW, "t1", tmp_path / "backup") == []

    meta, ctx = read_log(log)
    assert meta["payload"] == {"id": "t1", "cwd": NEW, "runtime_workspace_roots": [NEW]}
    assert ctx["payload"] == {"cwd": NEW + "\\pkg"}
    con = sqlite3.connect(db)
    assert con.execute("SELECT cwd FROM threads").fetchone() == ("\\\\?\\" + NEW,)
    con.close()
