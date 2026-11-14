# UI configuration

`configureReaderUi()` composes everything about the interface that is the same
for every book an application opens. It validates the Shell's settings, and
hands themes, Input Bindings and Compatibility Modules to Core's own
registries, so there is one catalog of each.

```tsx
import { configureReaderUi, EpubReader } from './epub-reader/react';

const configuration = configureReaderUi({
  themes: [productTheme],
  inputBindings: [vimNavigation],
  layout: { compactBreakpointPx: 640, panelWidthPx: 420 },
  appearance: { density: 'compact', motion: 'system' },
  messages: {
    reading: 'Now reading',
    endOfBook: 'The end.',
    sectionPosition: (section, total) => `${section}/${total}`,
  },
  tools: [readingStatisticsTool],
  surfaceRenderers: [productFootnoteRenderer],
});

<EpubReader source={book} configuration={configuration} />;
```

Create it once, outside render or in a `useMemo`. Core contributions are fixed
when a book opens; messages, density, motion, layout, tools and surface
renderers are read as the Shell renders.

## Settings

| Setting                      | What it does                                                        |
| ---------------------------- | ------------------------------------------------------------------- |
| `messages`                   | replaces any of the interface's strings; dynamic ones are functions |
| `layout.compactBreakpointPx` | width below which panels become sheets and tools a menu             |
| `layout.panelWidthPx`        | the widest a side panel gets (280–720)                              |
| `appearance.density`         | `comfortable` or `compact` spacing                                  |
| `appearance.motion`          | follow the system, or always `reduced`                              |
| `themes`                     | themes added to the built-in catalog                                |

Unknown fields, unsafe sizes, unknown values, empty messages and message
functions that return nothing are refused while composing. The configuration is
deliberately not a bag of CSS or render slots; the one layout hook outside it
is the `--epub-host-chrome-top` token for a host header (see
[Host integration](./host-integration.md)).

## Tools and surfaces

A Tool Module adds a panel of its own, with a toolbar entry in the
`navigation`, `primary` or `secondary` region. A Surface Renderer supplies the
content of an existing transient surface, such as the footnote popup. The Shell
keeps their layout, focus, dismissal and error containment either way.

[Extensions](./extensions.md) helps choose between them;
[`examples/reader-extensions.ts`](../examples/reader-extensions.ts) has
definitions that compile.
