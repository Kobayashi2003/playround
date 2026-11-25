# Using the reader in an application

The reader is not published as a package. An application copies it into its
own source tree and imports it from there.

## What to copy

Copy these, unchanged, into one folder of the application (for example
`src/vendor/epub-reader/`):

| Copy         | Why                                               |
| ------------ | ------------------------------------------------- |
| `core/`      | the engine                                        |
| `react/`     | the interface; leave out nothing, see below       |
| `types/`     | the stylesheet module declaration                 |
| `styles.css` | the one stylesheet entry, with its cascade order  |

Leave out everything that serves this package only: `showcase/`, `index.tsx`
and `meta.ts` (the Component Atlas demo), `tests/`, `conformance/`,
`fixtures/`, `scripts/`, `examples/`, the `tsconfig.*` files and
`package.json`.

Keep the four entries together on each update. The bundler loads the Kindle
adapter when the reader opens a Kindle file.

```ts
import { EpubReader, configureReaderUi } from './vendor/epub-reader/react';
import type { ReadingSessionStorage } from './vendor/epub-reader/core';
import './vendor/epub-reader/styles.css';
```

## What the application needs

- React 18 or later, and a bundler that understands CSS `@import` and dynamic
  `import()` (Vite does).
- TypeScript settings no stricter than the reader's own: `strict`,
  `noUncheckedIndexedAccess` and `noImplicitOverride` are all fine.
- The copy excluded from the application's ESLint and Prettier: it follows
  this package's rules, and reformatting it makes every update a conflict.

## Keep the copy identical

A copy that matches this folder byte for byte can be updated by copying again.
Keep application-specific behavior in the application's integration. Use
`configureReaderUi` for messages, themes, and layout, reader options and
storage ports for behavior, `readerRef` for driving the reader, and
`--epub-host-chrome-top` or documented `data-*` attributes for styling.
Change EPUB Reader when a fix belongs in the shared reader or a reusable
capability needs a new public interface. Fix reader bugs in EPUB Reader first
and distribute the fix from here to every consumer.

## Updating a copy

1. Read what changed here (the commit log of this folder).
2. Replace the copy's `core/`, `react/`, `types/` and `styles.css` with this
   folder's, deleting files that no longer exist.
3. Compare the copy with this folder; nothing should differ.
4. Run the application's type check, tests and build, and open a book.

Update every application that copies the reader together, not one at a time.
