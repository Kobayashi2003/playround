# Extensions

The reader exposes typed, bounded contribution points rather than a generic
plugin pipeline. Every contribution has a fixed phase, input, output, authority
boundary, validation rule, and lifecycle owner.

| Contribution         | Owner                   |
| -------------------- | ----------------------- |
| Compatibility Module | Core EPUB compatibility |
| Input Binding        | Core interaction input  |
| Theme                | Core appearance catalog |
| React Tool Module    | React fixed Shell       |
| Surface Renderer     | React semantic surfaces |

The complete checked example is
[`examples/reader-extensions.ts`](../examples/reader-extensions.ts).

## Registration and implementation

- [Core extension guide](../core/docs/extension-guide.md) covers compatibility
  modules, input bindings, themes, internal renderers, and locator channels.
- [React architecture](../react/docs/architecture.md) explains the fixed Shell
  authority retained around Tool Modules and Surface Renderers.
- [React module map](../react/docs/module-map.md) identifies the tool, surface,
  configuration, and composition modules.
- [UI configuration](./ui-configuration.md) shows host-facing registration.

Only the contribution types listed above are public extension points. The
decisions and rejected alternatives are recorded in
[ADR 0001](./adr/0001-controlled-reader-extension-boundaries.md) and
[ADR 0002](./adr/0002-controlled-react-ui-composition.md).
