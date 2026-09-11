# EPUB Reader documentation

The package documentation is organized by audience. Start with the integration
guides when embedding the reader; use the colocated Core and React guides when
changing implementation details.

## Integration guides

- [Getting started](./getting-started.md) renders a local EPUB with the supplied
  React interface.
- [Host integration](./host-integration.md) compares the complete Shell, a custom
  React interface, and direct Core integration.
- [Reading data](./reading-data.md) covers positions, preferences, marks, and
  replaceable persistence without storing book bytes.
- [UI configuration](./ui-configuration.md) configures the fixed Shell and
  registers React tools and surfaces.
- [Extensions](./extensions.md) helps hosts choose among the public, bounded
  contribution points.

## Architecture and maintenance

- [Architecture overview](./architecture.md) defines cross-layer ownership and
  dependency direction.
- [Core maintainer guide](../core/README.md) covers EPUB processing, rendering,
  interaction, and the framework-independent runtime.
- [React maintainer guide](../react/README.md) covers state adaptation, Shell
  composition, lifecycle, and colocated styles.
- [Domain language](../CONTEXT.md) defines canonical terms shared by all layers.
- [Test guide](../tests/README.md) explains verification levels and corpus
  commands.

Implementation details must have one authoritative home. If package-level
documentation overlaps `core/docs` or `react/docs`, keep the detailed explanation
beside the owning code and retain only integration context here.

## Decisions and planning

- [Architecture decision records](./adr/README.md) preserve accepted design
  constraints and their consequences.
- [Roadmap](./roadmap.md) separates single-publication Reader work from
  higher-level reading-suite capabilities.

## Architecture diagram

The overview diagram is generated from the editable Draw.io source in
[`diagrams/architecture-overview.drawio`](./diagrams/architecture-overview.drawio).
Run `npm run docs:diagrams` from this package after changing it. Set `DRAWIO_PATH`
when the Draw.io executable is not available on `PATH` or in its default install
location.
