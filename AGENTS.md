# AGENTS.md: rules for implementing agents

You are implementing **rooster**, a self-hosted, keyboard-first task manager. The specification in `docs/spec/` is the source of truth. Read it before writing code.

## Read first (in this order)
1. `docs/spec/00-overview.md`: decisions (D-xx) are **binding**.
2. `docs/spec/09-phases.md`: find your phase and work package (WP). Implement only that scope.
3. The specs your WP touches: `02-ux-interaction` (behaviour), `03-design-system` (visuals; binding), `04-architecture`, `05-data-model`, `06-api`, `07-cli`.
4. `docs/spec/10-quality.md`: the Definition of Done.

When documents conflict, the precedence is **00 > 05 > 06 > 02 > 03 > others**. Flag every conflict in your PR description. Never silently invent behaviour: if the spec is silent, choose the option most consistent with "the list is a text editor" and common task-manager conventions, and record it as an ADR in `docs/adr/NNNN-title.md`.

## Repository map
- `apps/server`: Hono API, better-auth, services (authorisation lives here), jobs, SSE.
- `apps/web`: React SPA + PWA. `src/ui` holds the Coop components; `src/features/*`; `src/data` holds queries, mutations, the outbox and SSE; `src/keymap.ts` is the single keymap registry.
- `apps/cli`: CLI, TUI (Ink) and MCP server.
- `packages/core`: **pure** TS (no IO): zod schemas and DTOs, dates (NL parse, format, dueState), recurrence, ordering, reducers, view selectors.
- `packages/api-client`: **generated** from OpenAPI. Do not edit it by hand (`pnpm gen:api`).
- `packages/i18n`: `locales/{en,sv}`. `packages/tokens`: Coop design tokens.

## Commands
```
pnpm i                 # install
pnpm dev               # server (:3000) + web (vite, proxied) in watch mode
pnpm build             # all packages
pnpm test              # vitest (unit/service/api)
pnpm e2e               # playwright
pnpm lint / pnpm format / pnpm typecheck
pnpm gen:api           # regenerate packages/api-client from the server's OpenAPI
pnpm i18n:check        # en/sv key parity
pnpm db:generate       # drizzle-kit generate (after schema changes)
```

## Hard rules
1. **Authorisation only in services.** Routes never query the DB directly. Every service method takes an `actor` and checks access (04 §4.3). Every new route needs a row in the authorisation matrix test.
2. **The server is authoritative for ordering.** Clients send `{beforeId, afterId}` intents, and the server computes fractional keys. Never use integer positions. Never sort with `localeCompare`.
3. **The placement invariant** (05 §4.1) holds after every transaction. Call `PlacementService.reconcilePlacements` whenever an assignee, parent or deletion changes.
4. **Every mutation goes through the pipeline** (04 §6.2): an optimistic reducer from `packages/core`, then the outbox, with `Idempotency-Key` and `X-Rooster-Edit-Time`. Never call `fetch` for mutations directly from components.
5. **Floating dates are strings** (`YYYY-MM-DD`). Never convert a due date to a JS `Date` for comparison. Use the `packages/core/dates` helpers with the user's timezone.
6. **No hard-coded UI strings.** Every string goes in both `en` and `sv`. Swedish must be natural (see the 03 §4 glossary).
7. **No hard-coded design values.** Use Coop semantic tokens and Tailwind theme classes only (03). Every new component gets a kitchen-sink entry at `/_dev/ui`.
8. **Keyboard parity.** Every pointer action has a keyboard path, registered in `keymap.ts`. Shortcut docs are generated from the registry, never duplicated.
9. **No modals** for everyday actions (02 §1). Use inline editing and anchored popovers.
10. **Migrations are append-only.** Never edit a merged migration.
11. **Do not add dependencies** whose purpose overlaps an existing one (see the stack table in 04 §2). Justify each new dependency in the PR.
12. **Tests are part of the work.** Name AC tests `AC-x.y …`. Keep `packages/core` coverage at or above 95 %.

## Conventions
- TypeScript strict and ESM everywhere. Named exports. No default exports, except where a framework requires them (route files).
- Zod schemas live in `packages/core/src/schemas`. Infer types from them (`z.infer`) rather than duplicating them.
- Errors are problem+json with a stable `code`. Throw `AppError(code, status, detail)` from services.
- IDs are UUIDv7 (`packages/core/ids`). Timestamps are ms epoch numbers.
- Files are kebab-case. React components are PascalCase. Hooks are `useX`.
- Comments explain *why*, not *what*. Do not write task-history comments.
- Commits and PR titles follow Conventional Commits (`feat(list): …`, `fix(sync): …`).

## Keeping this file current (mandatory)
This file is the entry point for every agent and must describe the repository **as it is now**, not as it was planned. In the same PR as the change, update `AGENTS.md` when you:
- add, rename or remove a top-level directory, app, package or important module (update the **Repository map**);
- add or change a script or command, a required env var, or a dev prerequisite (update **Commands**);
- introduce a convention, rule or pattern that other agents must follow, or retire one (update **Hard rules** / **Conventions**);
- complete a phase (update **Status** below), or record an ADR that changes how agents should work.

Keep the file concise. Put details in `docs/spec/` or `docs/adr/` and link to them. A PR that changes any of the above without updating `AGENTS.md` is not done.

## Status
- **Current phase:** Phase 0 (Foundations) not started. The spec is complete (v1.0, 2026-10-04).
- **Last completed phase:** none.

## When you finish a WP
- Run every gate in 10 §1.
- PR description: WP ID; the FR, AC and D IDs covered; deviations and ADRs; screenshots (UI); and how you verified it (tests plus a manual check).
