# collection-tree

Browsable HTML trees of selected folders in a file collection, built from Everything's HTTP
index (or a direct filesystem walk). Collection files are only read, never modified; only the
output folder is written.

## Run

Requires Python 3.10+; standard library only.

```powershell
python collection_tree.py                      # build, serve http://127.0.0.1:16040, open a browser
python collection_tree.py --build              # build only
python collection_tree.py --serve              # serve existing HTML without rebuilding
python collection_tree.py --config other.json
```

Keep the terminal running for **Rebuild all** and **Show in Explorer**; Ctrl+C stops the
service. Offline entry: `HTML/index.html`.

## Configure

Copy `settings.example.json` to `settings.json` (git-ignored) and edit it, then restart.
`settings.json` beside the script is loaded automatically; without it the defaults in
`collection_tree.py` apply. Main fields:

- `roots`: collection roots.
- `targets`: default `*/2. *`, `*/3. *`, `*/4. *`, `*/5. *` selects publisher-level categories. A name alone matches at any depth; a path selects a specific subtree. `*` stays within a segment; `**` crosses segments.
- `everything_url`: default `http://127.0.0.1:8081`. Optional username/password fields are available.
- `exclude`: excluded subtrees; Lose is excluded by default.
- `output`, `port`: default `HTML`, `16040`.

Credentials, if used, are saved locally in `settings.json` and `HTML/build-config.json`; keep them private.

## Pages

- Virtualized tree: expanding all 20k+ nodes stays instant. Folders show file count and total size.
- The default expand level is the smallest one that shows every target folder; a level you choose is kept for the session.
- Search over names and full paths; space-separated terms must all match. `/` focuses search, Esc clears, Enter/↓ jumps into the tree.
- Filters: collection root, file type (audio, images, video, discs & archives, documents) or folders only. The legend chips toggle type filters.
- Keyboard: ↑↓ move, ←→ collapse/expand or go to parent/child, Enter toggles, Ctrl+C copies the selected path.
- Breadcrumb of the selected path; click a segment to jump to it. **Show in Explorer** appears when the running service supports it (Windows, paths inside the configured roots only).
- Light/dark theme follows the system; the sidebar button overrides it.

New indexes in the same output directory appear after refreshing. Old indexes are retained when selections change.

## Notes

Everything mode does not scan collection directories. `--backend filesystem` enables direct
traversal. Disc images/archives remain files. A failed query preserves the previous HTML.

The service binds `127.0.0.1` only. Rebuild and reveal need the token written into the pages;
pages and `indexes.js` refuse cross-site requests so other websites cannot read it.
