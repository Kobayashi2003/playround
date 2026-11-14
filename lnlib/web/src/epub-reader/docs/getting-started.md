# Getting started

The quickest integration is the file picker plus the complete reader. The
book is opened in the browser and never uploaded.

```tsx
import { useState } from 'react';
import { EpubFilePicker, EpubReader } from './epub-reader/react';
import './epub-reader/styles.css';

export function LocalReader() {
  const [source, setSource] = useState<File | null>(null);
  return (
    <main style={{ height: '100dvh' }}>
      {source ? (
        <EpubReader source={source} />
      ) : (
        <EpubFilePicker onFile={setSource} />
      )}
    </main>
  );
}
```

- Give the reader's parent a real width and height; the reader fills it and
  waits until it has a size before opening the book.
- Import `styles.css` once. It is the one ordered entry for every stylesheet.

## The source

`source` may be a `Blob`, `File`, `ArrayBuffer` or `Uint8Array`. A new source
object opens a new book; re-rendering with the same object does not, even when
the other props are new inline objects. The host keeps the bytes; the reader
stores only the reading position, settings and marks.

## What comes built in

Contents (with page list and landmarks), search, bookmarks, highlights and
notes, settings (theme, typography, text direction, layout, touch, maintenance),
compatibility diagnostics, keyboard help, fullscreen, footnote and image
viewers, loading progress and error recovery. Links leaving the book are
checked and confirmed before they open.

Next: [Host integration](./host-integration.md) for callbacks, storage, and
your own controls; [Using the reader in an application](./vendoring.md) for
how to bring it into a project.
