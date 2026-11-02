# chatlog-viewer

A local web interface for reading Claude Code and Codex session logs, grouped by folder or by
time. User messages are shown in full; assistant replies, reasoning and tool calls are collapsed.
Log files are only read, except by Move (below).

## Run

Requires [uv](https://docs.astral.sh/uv/); standard library only.

```bash
uv run server.py                      # http://127.0.0.1:16010, opens a browser
uv run server.py --port 16011 --no-open
uv run server.py --reindex            # drop the cache and re-parse every log
uv run server.py --base-path /chatlog # serve under a path prefix
```

On Windows, `start.ps1` / `stop.ps1` start and stop the server.

## Log sources

| Source | Path |
| --- | --- |
| Claude Code | `~/.claude/projects/<project>/<sessionId>.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `~/.codex/archived_sessions/**` |

The first run indexes every session into `.cache/index.json` (safe to delete); later runs
re-parse only changed files. An open session is re-read when its log changes.
`CHATLOG_CACHE_DIR` moves `.cache/`, and `CHATLOG_DATA_DIR` moves `store.json`, `.trash/` and
`.backup/` (this folder by default); a relative path is relative to this folder.

## Search

The search box matches **user messages only**, as a case-insensitive literal substring (no
regex or word splitting). Results are ordered by session start time. Keys: `/` focus, `Esc`
leave, `j` / `k` move, `Ctrl+B` show or hide the session list.

The filter box at the top of the session list narrows it by folder, title, note or branch. The
View panel below it (collapsible) picks the source, grouping, starred / archived / missing
sessions and the folder order; the choices are remembered per browser. Below 860 px wide the
list becomes a drawer over the conversation.

The conversation is centred. When it has 1300 px or more, a column beside it shows the
session's duration, branch, model and ID, and every message I sent as a jump list that marks
the one being read.

## Managing sessions

Star, archive, rename and note are stored in `store.json`, keyed by log path. Delete moves the
log to `.trash/` under a timestamped name; move it back and reindex to restore it.

A session whose working folder no longer exists is marked **missing**; the **Missing** filter
lists them all.

**Move…** files a session under another working folder so `claude --resume` / `codex resume`
find it there. It can take every other session from the same folder along, which is the usual
case after renaming a folder. Only folder fields are rewritten, never message text:

- Claude Code: the `cwd` of every record, and the log (with its `<id>/` sidecar folder) moves to
  `~/.claude/projects/<new encoded folder>/`.
- Codex: `cwd` and `runtime_workspace_roots` in the log, in place, and `threads.cwd` in
  `~/.codex/state_*.sqlite`.

Paths under the old folder are remapped under the new one; paths elsewhere are left alone. The
target must exist. The original log is copied to `.backup/<timestamp>/` first. A log written in
the last two minutes is refused until confirmed, since a running session would keep writing to
the old file; close the session first.

**Copy resume** copies `cd "<folder>"; claude --resume <id>` (or `codex resume <id>`).
**Export .md** downloads my messages and the AI replies as Markdown.

## Checks

```bash
uv run ruff check && uv run ruff format --check && uv run basedpyright && uv run pytest
```

Codex sessions imported from Claude Code carry the import time on every record, so their
timestamps are not meaningful.
