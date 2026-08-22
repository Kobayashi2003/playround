# chatlog-viewer

中文：[README.zh.md](README.zh.md)

A local web interface for reading Claude Code and Codex session logs. Sessions are
grouped by working directory or by time. User messages are shown in full; assistant
replies, reasoning and tool calls are collapsed by default.

Python standard library only: no dependencies, no network access. Log files are read,
never modified.

## Running

```bash
python server.py              # start and open a browser (default http://127.0.0.1:8777)
python server.py --port 9000  # use a different port
python server.py --no-open    # do not open a browser
python server.py --reindex    # discard the cache and re-parse every log
python server.py --base-path /chatlog   # serve under a path prefix
```

On Windows, `start.cmd` runs the same command.

`--base-path` is for running behind a shared edge, where one public port fronts
several apps and the origin root belongs to none of them. The prefix is stripped
at the door, so every route keeps its own shape; the page links its assets
relatively and resolves API calls against its own directory, so nothing else has
to be told where it is mounted.

## Log sources

| Source | Path |
| --- | --- |
| Claude Code | `~/.claude/projects/<project>/<sessionId>.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `~/.codex/archived_sessions/**` |

## Indexing

The first run parses every session and writes a summary index to `.cache/index.json`
(116 sessions in under a minute on the development machine). Later runs re-parse only
files whose mtime or size changed. `Reindex` in the top bar starts an incremental
re-scan.

Session contents are parsed per request and not cached, so an open session always
reflects the current state of its log file. When a log has grown since it was
indexed, its index entry is rebuilt from that same parse.

## Interface

### Sidebar

- `Group`: Folder, Time or Flat. Folder grouping is case-insensitive, because Windows
  reports the working directory with inconsistent capitalisation.
- `Show`: All, ★ or Archived.
- `Hide sessions I never spoke in` (enabled by default) excludes sessions without user
  messages, such as those containing only a `/clear`.
- Source (Claude Code / Codex) is filtered from the top bar.
- Each row shows the size of its log file; each group header shows the group total.
- Width is set by dragging the divider (220–680 px); double-clicking it restores
  330 px. `Ctrl+B` or the ◀ button collapses the sidebar. Both settings are stored in
  `localStorage`.

### Transcript

- Each user message is rendered as a card. A message entered as a slash command shows
  the command name as a tag.
- Assistant activity between two user messages is collapsed into a single summary line
  (`AI  <first sentence>  2 replies · 11 tools`). Expanding it reveals the reply text,
  reasoning blocks and individual tool calls.
- Assistant replies are rendered as markdown: fenced code, headings, pipe tables with
  `:---:` alignment, nested lists, task lists, block quotes, horizontal rules,
  strikethrough, inline code and links. A line is parsed as a table header only when
  the following line is a delimiter row with an equal cell count; other lines
  containing `|` are treated as text.
- `Markdown` / `Raw text` switches all assistant replies and reasoning blocks between
  rendered output and unmodified source in monospace. The setting applies to every
  session and is stored in `localStorage`.
- `↑ Newest first` reverses the transcript. The unit reversed is the exchange — one
  user message together with the assistant activity that followed it — so a reply is
  never placed above the message it answers. Stored in `localStorage`.
- A message that was cancelled and retyped is shown greyed out and struck through,
  with a `CANCELLED` tag. The rule is structural: a user message is marked when
  another user message follows it with no assistant activity in between. The last
  message of a session is never marked, since a session may still be running.
- `⟳ Refresh` re-reads the open log without leaving the session. The file is also
  polled every 4 seconds while the tab is visible, and re-read only when its mtime or
  size changed, so a session still being written can be followed live. Scroll
  position, expanded assistant turns, and collapsed sidebar groups are preserved
  across a reload; the header and sidebar counts are updated.
- `Expand all AI`, `Collapse all` and `Only my messages` affect the open session only.
- The theme follows the system light/dark preference. The session path is held in the
  URL fragment, so individual conversations can be bookmarked.

## Search

The top-bar field matches user messages only. Assistant replies and tool output are
not indexed.

- Plain substring match, case-insensitive. No regular expressions, fuzzy matching or
  word segmentation. The query is matched as a single literal string, so `docker 配置`
  matches only where those characters appear consecutively.
- Matching runs on the server against the text collected during indexing and covers
  all sessions. The request is sent 120 ms after the last keystroke; matching itself
  completes in single-digit milliseconds across 116 sessions.
- Status is reported from the first keystroke: a spinner and `Searching…` before the
  request is sent, then `N sessions` or `No matches`. Responses carry a sequence
  number, and a response that arrives after a newer query has been issued is discarded.
- Results replace the sidebar listing and remain subject to the source, ★ and archived
  filters. Each row shows the occurrence count and the first matching snippet.
- The query is highlighted in the session title, the sidebar snippet, and the user
  message cards of the opened session.
- Limits: 30 000 characters of user text are indexed per session (`SEARCH_BUDGET` in
  `server.py`), at most 4 snippets are returned per session, and at most 400 sessions
  are returned. Results are ordered by session start time, descending — not by
  relevance.

Keys: `/` focuses the field, `Esc` leaves it, `j` and `k` move through the results.
Clearing the field restores the full listing.

## Session management

Log files are not modified. Flags are stored in `store.json`, keyed by log path.

| Action | Control | Effect |
| --- | --- | --- |
| Star | ☆ on a sidebar row, or the header button | Sets `star`; filtered by the ★ control |
| Archive | Header button | Excluded from `All`, listed under `Archived` |
| Rename | Header button | Overrides the title; an empty value restores the generated title |
| Note | Header button | Free text, shown in the header and on the sidebar row |
| Delete | Header button, confirmed by a second click | Moves the log to `.trash/` under a timestamped name |

Deletion is reversible: move the file from `chatlog-viewer/.trash/` back to its
original directory and run `Reindex`. `.trash/` is not emptied automatically.

Confirmation and text entry are inline. `confirm()` and `prompt()` are not used, as
both block the page.

## Identifying user input

The two log formats require different rules.

- **Claude Code**: records with `type == "user"` also carry tool results and injected
  context. Only records with `origin.kind == "human"` are treated as user input.
  `tool_result` blocks, `<system-reminder>` and `<local-command-stdout>` are
  classified as collapsed content.
- **Codex**: the `event_msg` stream (`user_message`, `agent_message`) holds the
  conversation as presented to the user, while `response_item` additionally contains
  injected blocks such as `<environment_context>` and `<recommended_plugins>`.
  Message content is therefore taken from `event_msg`, and tool calls from
  `response_item`.
- Slash command arguments (`<command-name>`) are user-typed text and are treated as
  ordinary messages, including for search. A command without arguments is rendered as
  a tag.

Known limitation: Codex sessions imported from Claude Code (recorded in
`~/.codex/external_agent_session_imports.json`) carry the import time on every record
rather than the time of the original conversation, so their timestamps are not
meaningful.

## Project layout

```
server.py     HTTP service, indexing and cache, search, management endpoints
parsers.py    both log formats mapped onto a shared turn model
static/       front end (vanilla JavaScript, no framework, no build step)
.cache/       derived index; safe to delete
store.json    stars, archive flags, renames and notes; the only non-derived state
.trash/       deleted logs
```

## HTTP API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/sessions` | Index listing with user flags merged in |
| GET | `/api/session?path=` | Parsed turns for one session; refreshes the index entry if the file grew |
| GET | `/api/peek?path=` | mtime and size of one log, for change detection |
| GET | `/api/search?q=` | Sessions matching a query, with snippets |
| GET | `/api/status` | Indexing progress |
| GET | `/api/reindex` | Start an incremental re-scan |
| POST | `/api/manage` | `{path, patch}`; patch keys: `star`, `archived`, `title`, `note` |
| POST | `/api/delete` | `{path}`; moves the log to `.trash/` |

## Turn model

| Role | Meaning |
| --- | --- |
| `user` | Human input. The only role counted in `N from me` and in search. Carries `superseded` when replaced before being answered |
| `command` | Slash command without arguments |
| `assistant` | Assistant reply text |
| `thinking` | Assistant reasoning block |
| `tool_use` | Tool invocation and its arguments |
| `tool_result` | Tool output |
| `user_auto` | A `user` record not originated by a human |
| `meta` | Injected system content |
