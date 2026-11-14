# EPUB Reader

A browser EPUB reader: a framework-independent Core engine and a complete
React interface on top of it. It reads reflowable and fixed-layout books,
horizontal and vertical text (and can re-set one as the other), paginated or
scrolled, with contents, search, bookmarks, highlights, notes, themes and a
remembered reading position. Kindle KF8 books (AZW3, and the KF8 part of a
combined MOBI) open through the same pipeline; DRM-protected and
Mobipocket-only files are refused with a diagnostic.

Book bytes stay with the host. The reader never uploads them, and by default
it keeps only the reading position, settings and marks, in `localStorage`.

## Quick start

```tsx
import { useState } from 'react';
import { EpubFilePicker, EpubReader } from './epub-reader/react';
import './epub-reader/styles.css';

export function LocalReader() {
  const [file, setFile] = useState<File | null>(null);
  return (
    <main style={{ height: '100dvh' }}>
      {file ? <EpubReader source={file} /> : <EpubFilePicker onFile={setFile} />}
    </main>
  );
}
```

The reader fills its parent, which must have a size. Applications use the
reader by copying it in: see
[Using the reader in an application](./docs/vendoring.md).

## Three ways in

| Entry                            | Use it when                                                  |
| -------------------------------- | ------------------------------------------------------------ |
| `EpubReader`                     | you want the whole reading interface                         |
| `useEpubReader` + `EpubViewport` | you draw your own interface around the reading area          |
| `BrowserEpubReader` (Core)       | you are not using React, or need to own the lifecycle itself |

[Host integration](./docs/host-integration.md) covers each, with every option.

## Documentation

Start at [docs/README.md](./docs/README.md). The terms used throughout are in
[CONTEXT.md](./CONTEXT.md).

## Checks

```sh
pnpm check           # module boundaries, type checks, unit and integration tests
pnpm browser:check   # the real interface in headless Chrome
pnpm visual:check    # visual baselines
```

The [test guide](./tests/README.md) lists the rest.
