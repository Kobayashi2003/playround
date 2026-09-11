---
status: accepted
---

# Keep React UI composition controlled by the Reader Shell

The React reader will support product-level composition through three explicit mechanisms: peer Tool Modules, one active Surface Renderer per semantic surface kind, and validated UI Configuration. It will not expose a generic React plugin array or arbitrary deep render slots.

The Reader Shell remains the fixed UI Kernel. It owns Core reader creation and disposal, viewport mounting, Reader Command and Reader Event routing, single-surface exclusivity, focus restoration, focus containment, inert background management, Escape behaviour, responsive measurement, modal semantics, and the safe external-link handoff. A contributed renderer may supply surface content, but it cannot replace the Shell wrapper that enforces those invariants.

## Consequences

- Tool metadata is the single source for toolbar placement, compact menus, panel headings, availability, and rendered content.
- Tool IDs are unique and deterministic; contributed tools are isolated by a UI error boundary so a render failure cannot remove the reading viewport.
- Surface Renderers are single-provider presentation roles rather than parallel middleware. Reader Events still pass through fixed Shell routing before a renderer is selected.
- UI Configuration controls a closed set of messages, density, motion, compact breakpoint, and panel width values. Theme definitions may additionally supply a validated host-UI token palette. Neither mechanism can inject arbitrary CSS selectors or replace Core services.
- Dynamic text uses message functions rather than string interpolation embedded throughout components, allowing pluralization and localization without moving domain decisions into translations.
- Settings remain one Tool Module. Its appearance, typography, layout, interaction, and maintenance sections may be split internally, but individual preference controls do not become plugins.
- Arbitrary React slots and custom Reader Commands are deferred until a concrete use case demonstrates that the typed Tool, Surface, and Configuration mechanisms cannot express it safely.

## Dependency direction

The React state adapter remains independent of UI composition. Configuration models and registries depend only on React public types and the public Core entry. Built-in composition may import panels and overlays; panels and overlays must not import the built-in registry or the Reader Shell. The public `EpubReader` is the final composition root.
