# Architecture decision records

Architecture decision records explain why a durable cross-layer boundary exists.
They supplement the current architecture guides; they do not replace them.

## Accepted decisions

- [ADR 0001](./0001-controlled-reader-extension-boundaries.md) uses
  phase-specific Core contribution points instead of a generic plugin pipeline.
- [ADR 0002](./0002-controlled-react-ui-composition.md) keeps React composition
  inside the fixed Reader Shell.

New records use the next four-digit number and a short kebab-case title. Record
the status, decision, considered alternatives, and consequences. Do not rewrite
an accepted decision to describe a new direction; supersede it with a new record.
