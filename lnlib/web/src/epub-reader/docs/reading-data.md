# Reading data

The reader separates host-owned EPUB bytes from resumable Reading Session data. No book bytes are persisted or uploaded by the reader.

## Session record

The framework-neutral `ReadingSessionRecord` contains:

- a resume Locator (the default React adapter stores the spine item and its progression);
- reader preferences when preference persistence is enabled;
- bookmarks, highlights, and annotations;
- an update timestamp.

The default React adapter saves `href`, `spineIndex`, and `locations.progression` for the resume position. It deliberately omits CFI, fragment, DOM-path, and text-quote anchors from that position. Reopening restores an approximate position within the section; changes in layout can change the visible passage. Bookmarks, highlights, and annotations retain their stored Locator anchors for precise navigation. This normalization happens before the storage port is called, so replacing storage alone does not change resume precision.

The React adapter derives a default key from publication bytes and an optional source name. Hosts may provide an explicit key when identity is already known.

## Storage

`ReadingSessionStorage` is a synchronous port with `load`, `save`, and `remove`. The default `BrowserReadingSessionStorage` uses `localStorage` on a best-effort basis and isolates storage or JSON failures from reading.

```tsx
<EpubReader
  source={file}
  readerOptions={{
    readingSession: {
      key: publicationId,
      storage: productReadingSessionStorage,
      persistPreferences: true,
      saveDelayMs: 500,
    },
  }}
/>
```

Pass `readingSession: false` to disable persistence. `reader.clearReadingSession()` removes the current persisted record without deleting the source. The complete settings tool exposes the equivalent local-data action.

This project is in development: persisted application records are disposable and are not migrated from older code schemas. Authored-book compatibility remains independent and is described in the [Core architecture](../core/docs/architecture.md).

The default browser adapter accepts only the complete current record shape. It rejects unknown fields, partial preferences or compatibility settings, malformed Locator channels, invalid mark variants, and invalid timestamps as one record rather than attempting partial recovery.

## Future data boundary

Backup, restore, cross-device sync, reading statistics, and library metadata belong above the single-publication Reader. They should consume explicit Reader Events and storage ports rather than make Core depend on an account, network, or book-library service. The split is listed in [Roadmap](./roadmap.md).
