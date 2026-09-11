# Roadmap

The roadmap separates capabilities of one opened publication from capabilities of a reading product that manages many publications, accounts, backups, or remote services.

## Reader capabilities

These belong in the reusable Reader or in Reader extensions because they operate on one Publication and its active Reading Session.

| Area                 | Current state                                                                                                                           | Target state                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Search               | exact text matching, whole-word/case options, excerpts, bounded in-memory indexes, chapter-grouped results, hit navigation              | persistent full-text index, fuzzy matching, query history, stronger in-content highlight navigation        |
| Annotations          | bookmarks, colored/styled highlights, notes, labels, tag editing/filtering, edit/remove, selection and bulk deletion, local persistence | annotation import/export                                                                                   |
| Bookmarks            | stable Locator, optional label, marks list and navigation                                                                               | groups, notes, richer preview and cross-section workflows                                                  |
| Reading position     | CFI plus fragment/DOM fallbacks, history navigation UI, section and publication progress                                                | stronger CFI recovery, finer section progress                                                              |
| Navigation documents | TOC, landmarks and page-list parsing; active TOC branch, session-scoped folding memory, dedicated page-list and landmark views          | broader navigation-document compatibility                                                                  |
| Media                | image activation and publication media inspection/routing foundations                                                                   | audio/video controls, Media Overlays and synchronized read-aloud                                           |
| Accessibility        | semantic Shell, keyboard help, focus/modal rules, current-position descriptions                                                         | broader screen-reader audit, complete keyboard paths, high-contrast policy and richer descriptions         |
| Themes               | validated publication/UI palette catalog and host registration                                                                          | theme editor, import/export and publication-specific assignment                                            |
| Input                | normalized keyboard, wheel, tap-zone and swipe bindings                                                                                 | user shortcut editor, mouse gestures, touch profiles and remote-control adapters                           |
| Layout               | reflowable/vertical/fixed/spread renderers, fit/gutter/touch controls                                                                   | richer spread rules, scroll refinement, vertical-writing details and comic workflows                       |
| Extension DX         | typed Core/UI contribution registries and validation                                                                                    | plugin manifest, capability declaration, API version checks, diagnostics and development tools             |
| Performance          | staged preflight, bounded search/content caches, cancellation and disposal                                                              | background preload policy, persistent index adapter, resource-cache tuning and large-book memory telemetry |

## Reading-suite capabilities

These belong above the Reader because they aggregate publications, depend on product identity, or coordinate durable/remote data.

| Area               | Reader contribution                                                         | Suite responsibility                                                              |
| ------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Reading statistics | emit stable semantic activity and position events                           | session timing, daily trends, estimates, aggregation and reporting UI             |
| Data management    | expose validated current-schema records and replaceable storage/event ports | import/export bundle, backup/restore, conflict policy and sync adapters           |
| Library            | expose normalized publication metadata and optional cover resources         | recent books, byte/source ownership, shelves, categories, tags and library search |

Statistics may be displayed by a Tool Module, but collection and long-term aggregation should not make one Reader instance own an account-wide database. Sync may implement a Reader storage port, but networking, authentication, retry, merging, and encryption remain suite concerns.

## Suggested delivery order

1. Harden stable Locator/session formats and extension diagnostics.
2. Complete search, mark, bookmark, TOC, accessibility, and input capabilities on current contracts.
3. Add persistent-index and data import/export ports without coupling them to one vendor.
4. Build statistics and library services above Reader Events and normalized metadata.
5. Publish a plugin SDK only after manifests, capability/version negotiation, state ownership, and debugging are testable as one lifecycle.
