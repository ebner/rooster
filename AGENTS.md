# AGENTS.md: rules for implementing agents

You are implementing **rooster**, a self-hosted, keyboard-first task manager. The specification in `docs/spec/` is the source of truth. Read it before writing code.

## Read first (in this order)
1. `docs/spec/00-overview.md`: decisions (D-xx) are **binding**.
2. `docs/spec/09-phases.md`: find your phase and work package (WP). Implement only that scope.
3. The specs your WP touches: `02-ux-interaction` (behaviour), `03-design-system` (visuals; binding), `04-architecture`, `05-data-model`, `06-api`, `07-cli`.
4. `docs/spec/10-quality.md`: the Definition of Done.

When documents conflict, the precedence is **00 > 05 > 06 > 02 > 03 > others**. Flag every conflict in your PR description. Never silently invent behaviour: if the spec is silent, choose the option most consistent with "the list is a text editor" and common task-manager conventions, and record it as an ADR in `docs/adr/NNNN-title.md`.

## Repository map
Entries marked *(planned)* do not exist yet. Create them in the phase that introduces them.
- `apps/server`: Hono API.
  - `src/main.ts`: boot (config → db → pre-migration backup → migrate → app → listen → scheduler).
  - `src/app.ts`: the pure `createApp(deps)`, used by tests.
  - `src/config.ts`: zod env schema. **Every env var lives here and in `.env.example`.**
  - `src/lib/`: errors (problem+json), logger, request id/log, security headers, SPA serving, graceful close.
  - `src/routes/`: one file per resource. Route zod schemas come from `@rooster/core/schemas`, registered in `routes/schemas.ts` with `.openapi('Name')`.
  - `src/auth/`: the better-auth instance (`auth.ts`), mounting under `/api/auth/*`, actor resolution (`actor.ts`), and signed cookies. better-auth handles **authentication only**; orgs are ours (ADR 0002).
  - `src/services/`: `OrgService`, `UserService`, `AdminService`, `GroupService`, `TaskService`, `PlacementService` (the 05 §4.1 invariant), `OrderingService` (all fractional keys are computed server-side), `BackupService` and `sign-in-policy.ts` (the allowlist rules). **All authorisation lives here.**
  - Request middleware covers idempotency (`Idempotency-Key`), edit time (`X-Rooster-Edit-Time`, clamped), client id/name, and the per-user rate limit. ADR 0005 has the list semantics.
  - `src/db/`: client and pragmas, `migrate.ts`, `schema/`, `migrations/` (generated, append-only).
  - `src/jobs/`: croner scheduler.
  - *(planned)* `src/events/` (SSE).
  - Tests live in `test/`. Helpers: `createTestDb`, `createTestApp`, `mock-idp.ts`, `signInAs(email)`.
  - `test/authz.matrix.test.ts` enumerates **every** OpenAPI route; a new route without a matrix row fails it.
  - The build bundles **all** JS deps into `dist/main.js`, except native modules (`NATIVE_DEPS` in `tsdown.config.ts`). Add a native dependency there **and** in `docker/Dockerfile`.
- `apps/web`: React SPA (+ PWA from P4).
  - `src/routes/`: TanStack file routes. `routeTree.gen.ts` is generated and committed. `src/routes/[_dev]/ui.tsx` is the dev-only kitchen sink at `/_dev/ui`; the brackets escape the underscore.
  - `src/ui/`: Coop components.
  - `src/features/*`: shell (sidebar, app frame), auth, org-settings, settings, admin (including backups), list (My tasks: rows, editing model, DnD, bulk bar, `controller` holding every command), dates (`DateLabel`, `DateCell`, `DatePopover`, `useViewerDateContext`).
  - `src/data/`: **the only place that talks to the API.** TanStack Query hooks over `createRoosterClient()`, query keys in `query-keys.ts`, problem+json mapped to `ApiError` in `errors.ts`, and better-auth client calls in `auth.ts` / `auth-client.ts`. Components take props; route components call `src/data` hooks.
  - `src/routes/_app.tsx`: the signed-in layout. Its `beforeLoad` guard redirects to `/login?redirect=…`.
  - `src/lib/`: `cn`, i18n, platform, and `safe-redirect.ts`. **Every redirect target must go through `safeRedirectPath()`.**
  - `src/data/pipeline/`: the **mutation pipeline**. Every list op goes `enqueue → core reducer on the cache → send (Idempotency-Key, edit time, client id) → merge`. Undo pushes inverse ops through it. It is an in-memory FIFO; the IndexedDB outbox arrives in P4.
  - `src/state/`: Zustand stores for list, undo and sync.
  - `src/keymap.ts`: **the single keymap registry** (02 §6). `useKeymap()` is mounted once at the root. The `?` cheat sheet is generated from it. ADR 0006 covers Tab chords.
  - `src/styles/theme.css`: token → Tailwind mapping.
  - `e2e/`: Playwright tests.
    - The config starts the mock IdP, the server (with a fresh temp data dir) and Vite.
    - `e2e/support/` has `signInAs`, `newClient` and `apiCall`. The sign-in identity is chosen with `login_hint`, and each browser sends its own `X-Forwarded-For` so the per-IP auth rate limit isn't shared.
  - *(planned)* the IndexedDB outbox and SSE in `src/data/` (P4).
- *(planned, P8)* `apps/cli`: CLI, TUI (Ink) and MCP server.
- `packages/core`: **pure** TS (no IO, no `Date.now()` inside functions):
  - `ids` (uuidv7)
  - `ordering` (fractional keys)
  - `dates` (iso helpers, `dueState`, `formatRelative`, and the NL parser `parseDatePhrase` / `findDateInTitle` / `findGroupToken`; ADR 0004)
  - `reducers` (`applyOp`, `inverseOf`, `mergeResponse`). These are the optimistic client-side mirror of the server semantics in ADR 0005; **change both together**.
  - `schemas` (shared zod)

  Imported as `@rooster/core/<module>`.
- `packages/api-client`: `schema.d.ts` is **generated** from `apps/server/openapi.json` (`pnpm gen:api`), so do not edit it. `src/index.ts` wraps it as `createRoosterClient()`.
- `packages/i18n`: `locales/{en,sv}/<namespace>.json` (ICU messages), plus `createI18n`/`initI18n`/`detectLocale`.
- `packages/tokens`: Coop tokens. `src/tokens.css` and `src/index.ts` must agree. A contrast test guards every allowed pair.
- `docker/`: `Dockerfile` (distroless, nonroot) and `proxy/` snippets. `compose.yaml` sits at the root.
- `scripts/`: `ci.sh` (the whole pipeline), `docker-smoke.sh`, `i18n-check.mjs`, and `dev-idp.mjs` (a mock OIDC provider for local dev and tests).
- `docs/spec/` (the spec), `docs/adr/` (decisions made during implementation).

## Commands
```
pnpm i                         # install (pnpm 12 via corepack; Node 24)
pnpm --filter @rooster/web exec playwright install chromium   # once, for e2e
pnpm dev:idp                   # mock OIDC provider on :9400 (start BEFORE pnpm dev; signs in as dev@example.com)
pnpm dev                       # server (:3000, tsx watch) + web (vite :5173, proxies /api)
pnpm build                     # all packages (web → apps/web/dist, server → apps/server/dist)
pnpm test                      # vitest, all projects
pnpm test:coverage             # vitest + coverage gate (run unfiltered: globs are repo-relative)
pnpm e2e                       # playwright (apps/web/e2e)
pnpm lint / pnpm format / pnpm typecheck
pnpm gen:api                   # emit apps/server/openapi.json, then regenerate packages/api-client
pnpm i18n:check                # en/sv parity, ICU validity, unused keys
pnpm db:generate               # drizzle-kit generate + STRICT post-processing
pnpm ci                        # full pipeline (scripts/ci.sh); add --with-docker for image build + smoke
node apps/web/scripts/render-icons.mjs   # regenerate PNG icons from the SVG mark
```
**Local dev:**
1. Copy `apps/server/.env.example` to `apps/server/.env` and uncomment the "Local development with the mock IdP" block.
2. Run `pnpm dev:idp`, then `pnpm dev`, then open http://localhost:5173 and use "Dev login".
3. To switch the identity for the next sign-in, call `curl -XPOST localhost:9400/__next-user -d '{"email":"bob@example.com"}'`.

At least one sign-in provider must be configured, or the server exits with code 78.

## Hard rules
1. **Authorisation only in services.** Routes never query the DB directly. Every service method takes an `actor` and checks access (04 §4.3). Every new route needs a row in the authorisation matrix test.
2. **The server is authoritative for ordering.** Clients send `{beforeId, afterId}` intents, and the server computes fractional keys. Never use integer positions. Never sort with `localeCompare`.
3. **The placement invariant** (05 §4.1) holds after every transaction. Call `PlacementService.reconcilePlacements` whenever an assignee, parent or deletion changes.
4. **Every list mutation goes through the pipeline** (04 §6.2): tasks, groups, tags and placements use an optimistic reducer from `packages/core`, then the outbox, with `Idempotency-Key` and `X-Rooster-Edit-Time`. Never call `fetch` for these directly from components. Settings, org administration and admin screens are online-only and use plain TanStack Query mutations through `@rooster/api-client`.
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
- Zod schemas live in `packages/core/src/schemas`. Infer types from them (`z.infer`) rather than duplicating them. The server registers them for OpenAPI with `.openapi('Name')`.
- **Tailwind classes = utility + token name** (full mapping at the top of `apps/web/src/styles/theme.css`):
  - colours: `bg-bg-app`, `text-text-muted`, `border-border-strong`, `text-date-overdue`, `bg-tag-red-bg`
  - type: `text-xs` … `text-2xl`, `text-group`
  - spacing: only the 4 px scale from 03 §2.6
  - sizes: `h-row`, `h-control`, `size-hit-touch`
  - radius and shadow: `rounded-sm`, `shadow-md`
  - motion and stacking: `duration-(--dur-fast)`, `z-(--z-toast)`
  - breakpoints: `tablet:`, `desktop:`, `wide:`, `pointer-coarse:`

  Tailwind's default palette and scales are **removed**, so off-token classes silently do nothing. Use `cn()` from `src/lib/cn.ts` to merge classes.
- Kitchen-sink states are forced with `data-force="hover|pressed|focus"`.
- Spec gaps decided during implementation are recorded in `docs/adr/` (e.g. ADR 0001: date formatting details).
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
- **Current phase:** Phase 3 (detail pane, subtasks, tags) is next.
- **Last completed phase:** Phase 2, List core (2026-10-05). AC-2.1 to AC-2.12 pass (unit, API and e2e). ADRs 0004 to 0006 record the parser, server and web decisions.
- **Deferred (owned by later WPs):** avatar upload (P10), linked identities (P8). `UserService.reorderOrg` should move onto `OrderingService` when it is next touched.

## When you finish a WP
- Run every gate in 10 §1.
- PR description: WP ID; the FR, AC and D IDs covered; deviations and ADRs; screenshots (UI); and how you verified it (tests plus a manual check).
