# Extensions

The reader has five typed contribution points, not a plugin list. Each has a
fixed phase, input, output, validation and owner.

| You want to                                       | Contribute a          | Owned by                      | Registered through               |
| ------------------------------------------------- | --------------------- | ----------------------------- | -------------------------------- |
| repair a known fault in how books are authored    | Compatibility Module  | Core, EPUB compatibility      | `configureReaderUi` / Core       |
| map a key, tap, swipe or wheel to a command       | Input Binding         | Core, interaction input       | `configureReaderUi` / Core       |
| add a reading appearance                          | Theme                 | Core, appearance catalog      | `configureReaderUi` / Core       |
| add a panel of your own                           | Tool Module           | React, the fixed Shell        | `configureReaderUi`              |
| draw a footnote, image or other surface your way  | Surface Renderer      | React, semantic surfaces      | `configureReaderUi`              |

Everything else (renderers, locator channels, the generic mechanisms under
`core/extension`) is internal and changes with the reader.

- How to write each: the [Core extension guide](../core/docs/extension-guide.md)
  and the [React architecture](../react/docs/architecture.md).
- Registering them: [UI configuration](./ui-configuration.md).
- Compiled examples: [`examples/reader-extensions.ts`](../examples/reader-extensions.ts).
- Why it is bounded this way: [ADR 0001](./adr/0001-controlled-reader-extension-boundaries.md)
  and [ADR 0002](./adr/0002-controlled-react-ui-composition.md).
