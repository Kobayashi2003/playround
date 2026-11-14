---
status: accepted
---

# Let a host header share the toolbar through a layout token, not a render slot

Applications that embed the reader inside their own screen want their header
(back to the library, the book's place in a series, controls of their own) to
read as one header with the reader's toolbar: shown and hidden together, with
the reader's panels opening below both. Without support, a host had to restate
the toolbar's height and override the Shell's internal classes, which breaks
whenever the Shell changes.

The Shell reserves the room instead. A host sets `--epub-host-chrome-top` (its
bar's height, which may include the top safe area) on an ancestor of the
reader; the toolbar grows by that much at its top, and everything that keeps
clear of the chrome reads the larger `--epub-chrome-top`. The host draws its
bar over the room itself, and `EpubReader` tells it through
`onChromeVisibilityChange` when the chrome appears or hides.

## Considered options

- A `header` render slot inside the toolbar was rejected for the reason in
  ADR 0002: a slot hands arbitrary content to the Shell's focus, dismissal and
  layout rules, which then have to account for it.
- A `layout.hostChromeTopPx` configuration number was rejected because a host
  bar's height usually depends on `env(safe-area-inset-top)`, which only CSS
  can express.

## Consequences

- The token is part of the public contract and is documented with the other
  layout tokens; it is never defined inside the Shell, so an ancestor's value
  comes through.
- The Shell still owns its toolbar. The host owns its bar, its focus order and
  its accessibility.
- Visibility is reported, not controlled: the host cannot hold the chrome open.
  Should that be needed, it belongs in a Reader Command, not in the token.
