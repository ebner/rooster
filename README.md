# 🐓 rooster

A self-hosted, keyboard-first task manager.

- **Groups:** personal, drag-sortable groups like *Today*, *Prio* and *Upcoming*, in exactly the order you choose.
- **Inline everything:** Enter for a new task, `fri` in the title for a due date, drag and drop to reorder. No dialogs.
- **Detail pane:** a side pane for descriptions (Markdown), subtasks, tags and comments.
- **Organisations:** keep private and business tasks apart, with light collaboration in shared orgs.
- **Sign-in:** OIDC (Google, Keycloak, Authentik and others).
- **Clients:** an installable mobile PWA (offline reading and queued edits), plus a CLI, a TUI and an MCP server.
- **Hosting:** one Docker container and one SQLite volume.

**Status:** the specification is complete and implementation has not started. See [`docs/spec/`](docs/spec/00-overview.md).

| Doc | |
|---|---|
| [Overview & decisions](docs/spec/00-overview.md) | [Product requirements](docs/spec/01-product.md) |
| [UX & interaction](docs/spec/02-ux-interaction.md) | [Design system "Coop"](docs/spec/03-design-system.md) |
| [Architecture](docs/spec/04-architecture.md) | [Data model](docs/spec/05-data-model.md) |
| [API](docs/spec/06-api.md) | [CLI, TUI & MCP](docs/spec/07-cli.md) |
| [Operations](docs/spec/08-operations.md) | [Phases](docs/spec/09-phases.md) |
| [Quality](docs/spec/10-quality.md) | [Agent rules](AGENTS.md) |
