# Host integration

Choose the highest-level boundary that satisfies the product. Higher-level entry points retain more reader invariants for the host.

| Entry point                      | Host owns                                          | Reader owns                                        |
| -------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| `EpubReader`                     | source selection and surrounding product           | Core lifecycle and complete accessible Shell       |
| `useEpubReader` + `EpubViewport` | React composition and controls                     | Core lifecycle, source races, viewport observation |
| `BrowserEpubReader`              | framework adapter, viewport element, subscriptions | one opened Core Reading Session                    |

Import React APIs from `react/index.ts` and Core APIs from `core/index.ts`. Deep imports make an integration depend on internal file organization.

## Complete React Shell

```tsx
<EpubReader
  source={file}
  configuration={readerConfiguration}
  readerOptions={{
    onReady: (snapshot) => reportOpened(snapshot.publication.metadata.title),
    onError: reportReaderError,
    onEvent: reportReadingActivity,
    readingSession: { saveDelayMs: 500 },
  }}
/>
```

`configuration` is validated composition shared across reader instances. `readerOptions` contains per-session Core policies, initial preferences, callbacks, cache limits, and persistence settings. Core contributions are supplied through `configuration`, so the React component deliberately removes `readerOptions.extensions`.

Callbacks are refreshed without reopening the book. Options consumed while opening—such as initial preferences, archive limits, mark storage, and Reading Session settings—take effect on the next source open. Change active preferences through `reader.setPreferences()` inside a custom integration or through the built-in settings UI.

## Persistence

By default the React adapter uses browser `localStorage` when available. Disable it with `readingSession: false`, supply a stable host key with `readingSession.key`, or inject an implementation of `ReadingSessionStorage`. Details are in [Reading data](./reading-data.md).

## External links

Core resolves internal publication targets first. Only policy-approved `http`, `https`, `mailto`, and `tel` destinations reach `onExternalLink`; executable and unsupported schemes stay blocked. Without a host callback, the complete Shell shows its fixed confirmation flow and opens websites with isolation flags.

## Custom interfaces

`useEpubReader(source, options)` returns an immutable state snapshot, a `viewportRef`, navigation methods, preference commands, search, marks, and selection operations. Pass that handle to `EpubViewport`; the component attaches `viewportRef` to its own region. Make that viewport itself focusable when it should receive keyboard input, because Core input handling is bound to the same element.

Use `BrowserEpubReader.open()` only when the host is not React or must own the adapter lifecycle. The host must then provide a measured container, subscribe to snapshots, forward viewport changes, and call `dispose()`.
