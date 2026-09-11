# EPUB Reader

A local-first EPUB reader with a framework-independent browser core and an optional React interface.

## Usage

```tsx
import { useState } from 'react'
import { EpubFilePicker, EpubReader } from './react'
import './styles.css'

const [file, setFile] = useState<File | null>(null)

<EpubFilePicker onFile={setFile} />
{file ? <EpubReader source={file} /> : null}
```

## API

- `EpubReader` renders the complete reader interface.
- `useEpubReader` and `EpubViewport` support custom React shells.
- `BrowserEpubReader` is the framework-independent browser composition root.
- `configureReaderUi` adds validated themes, input bindings, tools, surface renderers, and EPUB compatibility modules.

EPUB bytes and reading data remain local by default. The React source may be a `Blob`, `File`, `ArrayBuffer`, or `Uint8Array`; the lower-level Core reader accepts byte arrays.

See the [documentation](./docs/README.md), the
[Core maintainer guide](./core/README.md), the
[React maintainer guide](./react/README.md), and the
[checked extension example](./examples/reader-extensions.ts).
