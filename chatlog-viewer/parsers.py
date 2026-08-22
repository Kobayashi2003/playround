"""Parse Claude Code / Codex session logs into a common turn model."""
from __future__ import annotations

import json
import re
from pathlib import Path

HOME = Path.home()
CLAUDE_DIR = HOME / ".claude" / "projects"
CODEX_DIRS = [HOME / ".codex" / "sessions", HOME / ".codex" / "archived_sessions"]

SYSTEM_REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
CMD_NAME = re.compile(r"<command-name>(.*?)</command-name>", re.S)
CMD_ARGS = re.compile(r"<command-args>(.*?)</command-args>", re.S)

# Injected blocks: system-generated content, not user input.
NOISE_PREFIXES = (
    "<local-command-stdout>",
    "<user_instructions>",
    "<environment_context>",
    "<recommended_plugins>",
    "<available_skills>",
    "<ide_selection>",
    "<ide_opened_file>",
    "<ide_diagnostics>",
    "Caveat: The messages below",
    "[Request interrupted",
    "API Error",
)

USER_ROLES = ("user", "command")
AI_ROLES = ("assistant", "thinking", "tool_use", "tool_result")

MAX_TOOL_CHARS = 4000
MAX_TEXT_CHARS = 60000


def mark_superseded(turns):
    """Flag user messages that were replaced before they were answered.

    Cancelling a prompt and retyping it leaves both messages in the log, with no
    assistant activity between them. A trailing unanswered message is not flagged:
    it may simply be the newest one in a session that is still running.
    """
    last_user = None
    answered = False
    for t in turns:
        if t["role"] in USER_ROLES:
            if last_user is not None and not answered:
                last_user["superseded"] = True
            last_user, answered = t, False
        elif t["role"] in AI_ROLES:
            answered = True
    return turns


def _trunc(s, n):
    if not s:
        return ""
    return s if len(s) <= n else s[:n] + "\n\n… (truncated; %d chars in the original)" % len(s)


def iter_json(path):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line[0] != "{":
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue


def clean_text(text):
    """-> (kind, text, command_name). kind is text | command | noise.

    A slash command's arguments are user-typed text, so they are returned as `text`
    with the command name returned separately.
    """
    if not isinstance(text, str):
        return "noise", "", None
    t = SYSTEM_REMINDER.sub("", text).strip()
    if not t:
        return "noise", "", None
    if "<command-name>" in t:
        m1, m2 = CMD_NAME.search(t), CMD_ARGS.search(t)
        name = (m1.group(1).strip() if m1 else "").lstrip("/")
        args = m2.group(1).strip() if m2 else ""
        return "command", args, name
    for p in NOISE_PREFIXES:
        if t.startswith(p):
            return "noise", t, None
    return "text", t, None


def _preview(obj, n=400):
    try:
        s = json.dumps(obj, ensure_ascii=False)
    except Exception:
        s = str(obj)
    return s if len(s) <= n else s[:n] + "…"


# ---------------------------------------------------------------- Claude Code

def parse_claude(path):
    meta = {"source": "claude", "id": path.stem, "path": str(path), "cwd": None,
            "title": None, "branch": None, "version": None, "model": None}
    turns = []
    for rec in iter_json(path):
        t = rec.get("type")
        if t == "ai-title" and rec.get("aiTitle"):
            meta["title"] = rec["aiTitle"]
            continue
        if t == "summary" and rec.get("summary"):
            meta["title"] = meta["title"] or rec["summary"]
            continue
        if not meta["cwd"] and rec.get("cwd"):
            meta["cwd"] = rec["cwd"]
        if not meta["branch"] and rec.get("gitBranch"):
            meta["branch"] = rec["gitBranch"]
        if not meta["version"] and rec.get("version"):
            meta["version"] = rec["version"]

        ts = rec.get("timestamp")
        side = bool(rec.get("isSidechain"))

        if t == "user":
            msg = rec.get("message") or {}
            content = msg.get("content")
            human = (rec.get("origin") or {}).get("kind") == "human"
            blocks = [{"type": "text", "text": content}] if isinstance(content, str) else (content or [])
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                bt = b.get("type")
                if bt == "tool_result":
                    c = b.get("content")
                    if isinstance(c, list):
                        c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
                    turns.append({"role": "tool_result", "ts": ts, "sidechain": side,
                                  "text": _trunc(str(c or ""), MAX_TOOL_CHARS),
                                  "error": bool(b.get("is_error"))})
                elif bt == "text":
                    kind, txt, cmd = clean_text(b.get("text", ""))
                    if kind == "noise":
                        turns.append({"role": "meta", "ts": ts, "sidechain": side,
                                      "text": _trunc(txt, MAX_TOOL_CHARS)})
                    elif kind == "command":
                        turn = {"role": "user" if txt else "command", "ts": ts,
                                "sidechain": side, "cmd": cmd,
                                "text": _trunc(txt or cmd, MAX_TEXT_CHARS)}
                        turns.append(turn)
                    else:
                        turns.append({"role": "user" if human else "user_auto", "ts": ts,
                                      "sidechain": side, "text": _trunc(txt, MAX_TEXT_CHARS)})
                elif bt == "image":
                    turns.append({"role": "user", "ts": ts, "sidechain": side, "text": "[image]"})
        elif t == "assistant":
            msg = rec.get("message") or {}
            if not meta["model"] and msg.get("model"):
                meta["model"] = msg["model"]
            for b in msg.get("content") or []:
                if not isinstance(b, dict):
                    continue
                bt = b.get("type")
                if bt == "text" and (b.get("text") or "").strip():
                    turns.append({"role": "assistant", "ts": ts, "sidechain": side,
                                  "text": _trunc(b["text"], MAX_TEXT_CHARS)})
                elif bt == "thinking" and (b.get("thinking") or "").strip():
                    turns.append({"role": "thinking", "ts": ts, "sidechain": side,
                                  "text": _trunc(b["thinking"], MAX_TEXT_CHARS)})
                elif bt == "tool_use":
                    turns.append({"role": "tool_use", "ts": ts, "sidechain": side,
                                  "name": b.get("name", "tool"),
                                  "text": _preview(b.get("input"))})
        elif t == "system" and rec.get("content"):
            turns.append({"role": "meta", "ts": ts, "sidechain": side,
                          "text": _trunc(str(rec["content"]), 1000)})
    return {"meta": meta, "turns": mark_superseded(turns)}


# --------------------------------------------------------------------- Codex

def _user_turn(cleaned, ts):
    kind, txt, cmd = cleaned
    if kind == "noise":
        return {"role": "meta", "ts": ts, "text": _trunc(txt, MAX_TOOL_CHARS)}
    if kind == "command":
        return {"role": "user" if txt else "command", "ts": ts, "cmd": cmd,
                "text": _trunc(txt or cmd, MAX_TEXT_CHARS)}
    return {"role": "user", "ts": ts, "text": _trunc(txt, MAX_TEXT_CHARS)}


def _codex_text(content):
    if isinstance(content, str):
        return content
    out = []
    for b in content or []:
        if isinstance(b, dict):
            out.append(b.get("text") or b.get("input_text") or "")
        elif isinstance(b, str):
            out.append(b)
    return "\n".join(x for x in out if x)


def parse_codex(path):
    meta = {"source": "codex", "id": path.stem, "path": str(path), "cwd": None,
            "title": None, "branch": None, "version": None, "model": None}
    events, items = [], []
    for rec in iter_json(path):
        rt = rec.get("type")
        ts = rec.get("timestamp")
        p = rec.get("payload") or {}
        pt = p.get("type")

        if rt == "session_meta":
            meta["cwd"] = meta["cwd"] or p.get("cwd")
            meta["id"] = p.get("session_id") or meta["id"]
            meta["version"] = meta["version"] or p.get("cli_version")
            meta["model"] = meta["model"] or p.get("model") or p.get("model_provider")
            git = p.get("git") or {}
            if isinstance(git, dict):
                meta["branch"] = meta["branch"] or git.get("branch")
            continue
        if rt == "turn_context":
            meta["cwd"] = meta["cwd"] or p.get("cwd")
            meta["model"] = p.get("model") or meta["model"]
            continue

        if rt == "event_msg":
            if pt == "user_message":
                events.append(_user_turn(clean_text(p.get("message", "")), ts))
            elif pt == "agent_message":
                txt = (p.get("message") or "").strip()
                if txt:
                    events.append({"role": "assistant", "ts": ts, "text": _trunc(txt, MAX_TEXT_CHARS)})
            elif pt == "agent_reasoning":
                txt = (p.get("text") or "").strip()
                if txt:
                    events.append({"role": "thinking", "ts": ts, "text": _trunc(txt, MAX_TEXT_CHARS)})
            continue

        if rt == "response_item":
            if pt == "message":
                role = p.get("role")
                txt = _codex_text(p.get("content"))
                if role == "user":
                    items.append(_user_turn(clean_text(txt), ts))
                elif role == "assistant" and txt.strip():
                    items.append({"role": "assistant", "ts": ts, "text": _trunc(txt, MAX_TEXT_CHARS)})
                elif role in ("developer", "system") and txt.strip():
                    items.append({"role": "meta", "ts": ts, "text": _trunc(txt, MAX_TOOL_CHARS)})
            elif pt in ("function_call", "custom_tool_call", "local_shell_call"):
                items.append({"role": "tool_use", "ts": ts, "name": p.get("name") or pt,
                              "text": _preview(p.get("arguments") or p.get("input") or p.get("action"))})
            elif pt in ("function_call_output", "custom_tool_call_output"):
                out = p.get("output")
                if isinstance(out, dict):
                    out = out.get("content") or json.dumps(out, ensure_ascii=False)
                items.append({"role": "tool_result", "ts": ts,
                              "text": _trunc(str(out or ""), MAX_TOOL_CHARS)})
            elif pt == "reasoning":
                txt = _codex_text(p.get("summary") or p.get("content"))
                if txt.strip():
                    items.append({"role": "thinking", "ts": ts, "text": _trunc(txt, MAX_TEXT_CHARS)})
            continue

    # event_msg holds the conversation as presented to the user; response_item holds
    # the tool activity. Merge when both are present, otherwise use whichever exists.
    tool_items = [t for t in items if t["role"] in ("tool_use", "tool_result")]
    if events and tool_items:
        turns = sorted(events + tool_items, key=lambda t: (t.get("ts") or ""))
    elif events:
        turns = events
    else:
        turns = items
    return {"meta": meta, "turns": mark_superseded(turns)}


def parse(path, source):
    return parse_claude(path) if source == "claude" else parse_codex(path)


def discover():
    """-> list of (Path, source)"""
    found = []
    if CLAUDE_DIR.is_dir():
        for p in CLAUDE_DIR.glob("*/*.jsonl"):
            found.append((p, "claude"))
    for d in CODEX_DIRS:
        if d.is_dir():
            for p in d.rglob("*.jsonl"):
                found.append((p, "codex"))
    return found
