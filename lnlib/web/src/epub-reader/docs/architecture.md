# Architecture

Three layers, each depending only on the one below it:

```text
  host application      supplies the book, configuration and storage
        │
        ▼
  react/                EpubReader: the fixed Reader Shell
        │                 toolbar · panels · surfaces · focus · Chrome
        │  commands ↓     ↑ immutable snapshots and events
        ▼
  core/                 BrowserEpubReader: one open publication
                          epub/          archive → package → content → resources
                          presentation/  rendition plan → renderer → pages
                          interaction/   input · locators · navigation · selection
                          features/      search · marks · decorations · media
```

Core never imports React. A host imports `react/index.ts` or `core/index.ts`
and nothing deeper.

## Who owns what

| Layer | Owns                                                                                  | Never                                      |
| ----- | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| Host  | where the book comes from, the product around the reader, accounts, remote services   | reaches into reader internals              |
| React | the store around one Core reader, the Shell, focus and dismissal, responsive layout   | parses EPUB, plans renditions, moves pages |
| Core  | archive safety, the publication model, rendering, navigation, reading features        | knows about React or the product around it |

Archive safety and renderer transactions stay in Core; focus, dismissal and
accessibility stay in the Shell; product workflows stay in the host. Extension
points are typed and bounded, never a generic plugin list (see the
[ADRs](./adr/README.md)).

## From bytes to a page

1. **Archive.** The container format is detected and the archive opened under
   size and path limits. A Kindle KF8 book is reassembled into an in-memory
   EPUB; that code loads only when one is opened.
2. **Publication.** The package becomes a normalized `Publication`: metadata,
   reading order, navigation.
3. **Compatibility.** One Compatibility Profile is fixed for the session; its
   modules repair known authoring faults, each at its own stage.
4. **Content.** Documents are hardened (no scripts), their references rewritten
   to session-owned URLs, and inspected for writing mode and page structure.
5. **Plan.** The rendition planner combines the publication's intent, the
   content, the reader's preferences and the viewport into a `RenditionPlan`:
   which renderer, which writing mode, which page direction, one page or two.
6. **Render.** The renderer host commits the plan in an isolated iframe. Every
   step after an `await` is guarded, so a newer request always wins.
7. **Snapshot.** The committed position is published as a Locator inside an
   immutable snapshot. React renders the snapshot; the host may save it.

## Where to read next

- [Core architecture](../core/docs/architecture.md): opening, transactions,
  locators and invariants in detail.
- [React architecture](../react/docs/architecture.md): the store, the Shell, and
  how events become surfaces.
- [Domain language](../CONTEXT.md).
