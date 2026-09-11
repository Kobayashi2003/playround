---
status: accepted
---

# Use phase-specific compatibility modules and publication-scoped features

The reader will use controlled extension points instead of a generic plugin or middleware chain. The Kernel remains non-replaceable for archive and path safety, normalized Publication invariants, open/cancel/replace transactions, resource ownership and disposal, preflight and cache scheduling, renderer selection and atomic commits, iframe isolation, locator commits, Reader Snapshot publication, and external-link protocol safety; EPUB compatibility runs only through typed publication, content-document, resource, and rendition contracts, while peer reading functions run as publication-scoped Features that expose restricted Capabilities and emit read-only Reader Events.

## Considered options

- A single middleware pipeline was rejected because the reader crosses security, parsing, resource, rendering, and UI boundaries with different valid inputs and failure semantics.
- A generic `plugins` array was rejected because it would obscure whether an extension is a compatibility rule, peer Feature, Provider, or Observer and would make ordering and authority implicit.
- External renderer factories and raw ZIP recovery hooks are deferred because both currently participate in closed planning or security invariants rather than a stable extension contract.

## Consequences

- A Compatibility Profile has deterministic ordering and an identity included in content-document and search-index cache variants.
- If publication-scoped Feature registration becomes public, startup must occur only after Publication, resources, content processing, Renderer Host, and navigation services exist, but before the initial presentation; disposal must run in reverse startup order. The lifecycle primitive remains internal today.
- State is committed and a Reader Snapshot is published before Reader Events are dispatched; Observer failures are isolated.
- Any future Feature-specific persisted state must be namespaced, validated, and owned by the contributing Feature instead of being added permanently to the generic Reading Session codec.
- The currently public Core contribution buckets are Compatibility Modules, Input Bindings, and Themes. Publication-scoped Features, Capabilities, Providers, and Observers remain internal until their host authority and persisted-state ownership are complete.
