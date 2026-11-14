# EPUB Reader documentation

## Using the reader

- [Getting started](./getting-started.md): open a local book with the complete
  interface.
- [Using the reader in an application](./vendoring.md): what to copy, what not
  to change, and how to update a copy.
- [Host integration](./host-integration.md): the three entry points, every
  option, driving the reader from your own controls, and fitting your own
  header above its toolbar.
- [Reading data](./reading-data.md): what is saved, where, and how to replace
  the storage.
- [UI configuration](./ui-configuration.md): messages, layout, appearance,
  themes and contributed tools.
- [Extensions](./extensions.md): which contribution point fits which need.

## Changing the reader

- [Architecture](./architecture.md): the layers, who owns what, and how a book
  becomes pages.
- [Core](../core/README.md) and [React](../react/README.md): the maintainer
  guides of each layer, with their module maps.
- [Tests](../tests/README.md) and [conformance](../conformance/README.md).
- [Domain language](../CONTEXT.md).

Each detail has one home: integration context here, implementation detail
beside the code that owns it.

## Decisions and plans

- [Architecture decision records](./adr/README.md).
- [Roadmap](./roadmap.md).
