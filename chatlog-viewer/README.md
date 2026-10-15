# chatlog-viewer

A local web interface for reading Claude Code and Codex session logs, grouped by folder or by
time. User messages are shown in full; assistant replies, reasoning and tool calls are collapsed.
Log files are only read, never modified.

## Run

Requires Python 3.14; standard library only.

```bash
python server.py                      # http://127.0.0.1:16010, opens a browser
python server.py --port 16011 --no-open
python server.py --reindex            # drop the cache and re-parse every log
python server.py --base-path /chatlog # serve under a path prefix
```

On Windows, `start.ps1` / `stop.ps1` start and stop the server.

## Log sources

| Source | Path |
| --- | --- |
| Claude Code | `~/.claude/projects/<project>/<sessionId>.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `~/.codex/archived_sessions/**` |

The first run indexes every session into `.cache/index.json` (safe to delete); later runs
re-parse only changed files. An open session is re-read when its log changes.

## Search

The search box matches **user messages only**, as a case-insensitive literal substring (no
regex or word splitting). Results are ordered by session start time. Keys: `/` focus, `Esc`
leave, `j` / `k` move.

## Managing sessions

Star, archive, rename and note are stored in `store.json`, keyed by log path. Delete moves the
log to `.trash/` under a timestamped name; move it back and reindex to restore it.

Codex sessions imported from Claude Code carry the import time on every record, so their
timestamps are not meaningful.
