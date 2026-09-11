# UI configuration

`configureReaderUi()` is the React composition entry. It validates Shell settings and delegates themes, Input Bindings, and EPUB Compatibility Modules to the existing Core registries; React does not maintain parallel catalogs.

```tsx
import { configureReaderUi, EpubReader } from '../react'

const configuration = configureReaderUi({
  themes: [productTheme],
  inputBindings: [vimNavigation],
  layout: {
    compactBreakpointPx: 640,
    panelWidthPx: 420,
  },
  appearance: {
    density: 'compact',
    motion: 'system',
  },
  messages: {
    reading: 'Now reading',
    sectionPosition: (section, total) => `${section}/${total}`,
  },
  tools: [readingStatisticsTool],
  surfaceRenderers: [productFootnoteRenderer],
})

<EpubReader source={book} configuration={configuration} />
```

Create the configuration outside render or memoize it. Core contributions are fixed when the publication opens. Messages, density, motion, layout, tool availability, and Surface Renderer selection are consumed by the Shell while rendering.

## Closed Shell settings

- `messages` replaces individual static or dynamic user-facing strings.
- `layout.compactBreakpointPx` controls both responsive React semantics and compact CSS presentation.
- `layout.panelWidthPx` bounds the desktop side panel.
- `appearance.density` selects comfortable or compact Shell spacing.
- `appearance.motion` follows system motion or forces reduced motion.

Unknown fields, unsafe dimensions, unsupported enum values, empty messages, and invalid representative results from dynamic message functions are rejected while composing the configuration. Configuration is intentionally not an arbitrary CSS or render-slot bag.

## Extension registration

A Tool Module adds a peer panel feature in the `navigation`, `primary`, or `secondary` toolbar region. A Surface Renderer supplies content for an existing semantic transient surface. The fixed Shell continues to own their layout, focus, dismissal, and error boundaries.

See [Extensions](./extensions.md) for choosing a contribution type,
[`examples/reader-extensions.ts`](../examples/reader-extensions.ts) for compilable
definitions, and the [React architecture](../react/docs/architecture.md) for
internal composition and Shell ownership.
