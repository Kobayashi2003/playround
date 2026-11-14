# Reading data

The host owns the book's bytes; the reader never stores or uploads them. What
the reader saves, so a book reopens where it was left, is the **Reading
Session**: one record per book.

## The record

`ReadingSessionRecord` holds:

- `locator`: where the reader was. The React adapter keeps the document and
  the progression through it (not exact text anchors), so after a change of
  type size or screen the same passage is near, not necessarily first.
- `preferences`: the settings in force, when `persistPreferences` is on (the
  default).
- `marks`: bookmarks, highlights and notes, each with its own exact anchors.
- `updatedAt`.

The default storage accepts only a complete record of the current shape and
drops a malformed one whole rather than guessing. One exception keeps saved
places when the reader gains a setting: preferences saved before
`writingMode` existed read it as `auto`.

## Options

```tsx
<EpubReader
  source={book}
  readerOptions={{
    readingSession: {
      key: bookId,
      storage: productStorage,
      saveDelayMs: 500,
      preferenceScope: 'device',
    },
  }}
/>
```

| `readingSession.`    | Default              | What it does                                                                                     |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `key`                | from the book's bytes | which record is this book's; give your own when the product already knows the book             |
| `storage`            | `localStorage`        | a `ReadingSessionStorage`: synchronous `load`, `save`, `remove`                                 |
| `persistPreferences` | `true`               | whether settings are saved in the record                                                         |
| `preferenceScope`    | `'publication'`      | `'device'`: settings that describe the reader follow it from book to book (below)                |
| `preferenceStorage`  | `localStorage`        | a `ReaderPreferenceStorage` (`load`, `save`) for device-scoped settings                         |
| `saveDelayMs`        | `300`                | how long after the last change the record is saved                                               |

Pass `readingSession: false` to save nothing.

The storage port is synchronous because the reader reads it while opening. A
host that keeps sessions on a server fetches the record before opening, answers
`load` from memory, and sends `save` on in the background.

Saving happens after `saveDelayMs`, and once more when the reader closes. A
host that is about to read the session back (to open the same book in another
edition, or before the page goes away) calls `saveReadingSession()` on the
handle to save the latest position at once.

`clearReadingSession()` on the handle removes the record; the settings panel
offers the same.

## Settings: per book or per device

With the default `preferenceScope: 'publication'`, every book keeps its own
settings: a new book opens with the host's `preferences` and nothing else.

With `preferenceScope: 'device'`, the settings that describe how this person
reads are kept apart, in `preferenceStorage`, and laid over every book that
opens. What belongs to one book stays in that book's record.

| Follows the device (`DEVICE_PREFERENCE_KEYS`)                                         | Stays with the book                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------- |
| `theme`, `fontSizePercent`, `fontFamily`, `lineHeight`, `pageMarginPercent`           | `writingMode`, `pageProgression`            |
| `flow`, `spread`, `fixedLayoutFit`, `fixedLayoutGutter`                               | `compatibility`                             |
| `touchNavigation`, `pageTurnZonePercent`                                              |                                             |

A book opens with, from weakest to strongest: its saved settings, the host's
`preferences`, the device's settings. So the host can still decide what belongs
to the book (its `writingMode`, say), while what the reader chose on this
device wins over the host's defaults.

## Preferences

| Preference                                 | Values                                                         |
| ------------------------------------------ | -------------------------------------------------------------- |
| `theme`                                    | a theme id: `publisher`, `light`, `dark`, `sepia`, … or a host theme |
| `writingMode`                              | `auto` (as published), `horizontal-tb`, `vertical-rl`          |
| `pageProgression`                          | `auto`, `ltr`, `rtl`                                           |
| `flow`                                     | `auto`, `paginated`, `scrolled`                                |
| `spread`                                   | `auto`, `single`, `double`                                     |
| `fontSizePercent`                          | 50–300                                                         |
| `fontFamily`, `lineHeight`                 | a family name or `null`; 0.8–3 or `null`                       |
| `pageMarginPercent`                        | 0–18                                                           |
| `fixedLayoutFit`, `fixedLayoutGutter`      | `contain`, `width`, `height`, `original`; `none`, `normal`     |
| `touchNavigation`, `pageTurnZonePercent`   | `both`, `tap`, `swipe`, `off`; 10–40                           |
| `compatibility`                            | switches for each built-in repair                              |

`writingMode` re-sets reflowable text; fixed-layout pages are never changed.
With `pageProgression` on `auto`, pages then turn the way the new mode reads:
right to left for vertical text.

## Above the reader

Backups, sync across devices, statistics and libraries are a product's, not
the reader's. They build on the storage ports and Reader Events, so Core never
depends on an account, a network or a library (see the
[roadmap](./roadmap.md)).
