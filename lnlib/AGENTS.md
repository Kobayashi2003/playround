# lnlib

The server (`lnlib/`) is Python standard library only; the interface (`web/`) is
React built with Vite. `web/src/epub-reader/` is a copy of
`components/data-display/epub-reader`: change it upstream, then copy
it back.

## Toolchain (`web/`)

- Node is the version in `.node-version`; pnpm is the version in `packageManager`.
  Never use npm, npx or yarn; use `pnpm dlx` for a one-off tool.
- Add or remove a dependency with `pnpm add` / `pnpm remove`, and commit
  `pnpm-lock.yaml`.
- Before handing off: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`.

## Versions

- Installed versions may be newer than your training data. Check an API against
  the package in `node_modules` before using it.
- Do not change Node, pnpm, or a dependency's major version unless asked.

## Writing

- Write docs and comments in English, and only when the code cannot say it.
- This file is the only agent instruction file; `CLAUDE.md` imports it.
