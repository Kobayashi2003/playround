# Host integration

Choose the highest entry that does what the product needs; the higher it is,
the more the reader keeps right for you.

| Entry                            | The host owns                                      | The reader owns                                     |
| -------------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| `EpubReader`                     | the source and the product around it               | the Core lifecycle and the whole accessible Shell   |
| `useEpubReader` + `EpubViewport` | the interface around the reading area              | the Core lifecycle, source races, viewport sizing   |
| `BrowserEpubReader`              | the framework adapter, the element, subscriptions  | one open publication                                |

Import from `react/index.ts` and `core/index.ts` only; deeper paths are
internal and move without notice.

## The complete reader

```tsx
const readerRef = useRef<EpubReaderHandle | null>(null);

<EpubReader
  source={book}
  configuration={configuration}
  readerRef={readerRef}
  onChromeVisibilityChange={setBarVisible}
  readerOptions={{
    preferences: { theme: 'dark' },
    readingSession: { key: bookId, storage, saveDelayMs: 500 },
    onReady: (snapshot) => report(snapshot.publication.metadata.title),
    onEvent: (event) => {
      if (event.type === 'navigation-boundary') openNeighbour(event.edge);
    },
    onError: reportError,
  }}
/>
```

### Props

| Prop                       | What it does                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `source`                   | the book: `Blob`, `File`, `ArrayBuffer` or `Uint8Array`; a new object opens a new book      |
| `configuration`            | from `configureReaderUi()`; see [UI configuration](./ui-configuration.md)                   |
| `readerOptions`            | everything below; consumed when a book opens                                               |
| `readerRef`                | filled with the reader's handle while mounted, cleared on unmount                           |
| `onChromeVisibilityChange` | told `true`/`false` as the toolbar and controls appear and hide                             |
| `onThemeChange`            | told the active theme whenever it changes                                                   |

### Reader options

| Option                                         | What it does                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `preferences`                                  | settings a book opens with (see the table in [Reading data](./reading-data.md))                    |
| `readingSession`                               | saving the position, settings and marks; `false` turns it off ([Reading data](./reading-data.md))  |
| `initialLocator`, `initialSpineIndex`          | where to open, over any saved position                                                             |
| `onReady`, `onError`                           | the book opened; a command or the opening failed                                                   |
| `onEvent`                                      | Reader Events: `navigation-boundary` (turning past the first or last page), `bookmark-added`, `footnote-activated`, `selection-changed`, `mark-activated`, `image-activated` |
| `onOpenProgress`, `onDiagnostics`              | opening progress; diagnostics about the book                                                       |
| `onExternalLink`, `onUnresolvedPublicationLink`| a link leaving the book (safe schemes only); a link inside it that leads nowhere                   |
| `onCommand`                                    | an input the reader leaves to the product                                                          |
| `markStore`                                    | where marks live, instead of inside the reading session                                            |
| `compatibilityMode`                            | `compatible` (default) or `strict` archive handling                                                |
| `archiveLimits`, `controlDocumentLimits`, `resourcePolicy`, `inputPolicy`, `plannerPolicy`, `searchCachePolicy`, `contentDocumentCachePolicy`, `signal` | safety limits, policies, cache sizes, and cancelling an open |

Callbacks may be new closures on every render; they are picked up without
reopening the book. Everything else is read when a book opens, so a change
takes effect with the next book. To change settings of the open book, use the
handle.

## Driving the reader from your own controls

`readerRef.current` (or the return value of `useEpubReader`) is the
`EpubReaderHandle`: navigation (`next`, `previous`, `goTo`, `history`),
`setPreferences`, search, marks, selection, and the session commands.

```ts
// A "vertical / horizontal" switch of the host's own.
readerRef.current?.setPreferences({ writingMode: 'vertical-rl' });

// About to leave, or to open another edition that reads the session back:
// save the latest page turn now instead of after the save delay.
readerRef.current?.saveReadingSession();
```

## A header of your own above the toolbar

The Shell's toolbar can make room for a host bar, so the two read as one
header and the Shell's panels open below both. Set the bar's height on any
ancestor of the reader and place the bar over that room; hide it when the
Shell hides its controls:

```css
.reading-page {
  --epub-host-chrome-top: calc(44px + env(safe-area-inset-top));
}
.reading-page .host-bar {
  position: absolute;
  inset: 0 0 auto;
  height: var(--epub-host-chrome-top);
  z-index: 40;
}
```

```tsx
<div className="reading-page">
  <header className="host-bar" hidden={!barVisible}>…</header>
  <EpubReader source={book} onChromeVisibilityChange={setBarVisible} />
</div>
```

A bar that includes the top safe area takes it over from the toolbar. The
toolbar keeps its own height beneath the bar; nothing reflows when either
appears or hides.

## Links that leave the book

Links inside the book are followed by the reader. Only `http`, `https`,
`mailto` and `tel` links reach `onExternalLink`; anything else is blocked.
Without the callback, the Shell asks before opening a website, and opens it
isolated from the reader.

## Your own interface

`useEpubReader(source, options)` takes the same options and returns the
handle. Pass the handle to `EpubViewport`, which attaches the reader to its own
element; give that element the focus (`tabIndex`), since the reader's keyboard
handling is bound to it.

## Without React

`BrowserEpubReader.open(bytes, element, options)` opens one book in a measured
element. The host subscribes to snapshots, forwards size changes with
`syncViewportFromElement()`, and calls `dispose()` when done. Persistence is
the host's: `ReadingSessionStorage` is a port, not a behaviour of Core.
