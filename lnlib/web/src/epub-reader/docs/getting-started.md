# Getting started

The quickest integration uses the supplied file picker and complete React Shell. The host owns the EPUB file; the reader opens it in the browser and does not upload it.

```tsx
import { useState } from "react";
import { EpubFilePicker, EpubReader } from "../react";
import "../styles.css";

export function LocalReader() {
  const [source, setSource] = useState<File | null>(null);

  return (
    <main style={{ height: "100dvh" }}>
      {!source ? <EpubFilePicker onFile={setSource} /> : null}
      {source ? <EpubReader source={source} /> : null}
    </main>
  );
}
```

The reader viewport must receive a non-zero width and height. Import `styles.css` once; it is the ordered entry point for tokens, Shell layout, tools, overlays, settings, and responsive rules.

## Source lifetime

`EpubReader` accepts `Blob`, `File`, `ArrayBuffer`, or `Uint8Array`. A new source object opens a new Reading Session. Re-rendering with the same source does not reopen the publication, even when callback options are inline objects.

The host remains responsible for selecting, replacing, and retaining the source bytes. The default Reading Session storage persists resumable data only, never the EPUB bytes.

## Built-in behavior

The complete Shell includes contents, search, marks, compatibility diagnostics, settings, keyboard help, fullscreen, semantic transient surfaces, loading feedback, and error recovery. External publication links are checked by Core policy and require confirmation before the default React handler opens them.

Continue with [Host integration](./host-integration.md) when the host needs callbacks, custom storage, Core options, or a custom interface.
