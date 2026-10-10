# Contributing to rooster

Thanks for helping. rooster is a self-hosted, keyboard-first task manager built from a written specification. This file covers the development setup, how work is organised, the quality gates and the conventions. [`AGENTS.md`](AGENTS.md) is the detailed reference: the full repository map, the hard rules and the current phase. Read it before your first change.

## Development setup

**Prerequisites:** Node 24 and pnpm (through corepack: `corepack enable`). For the end-to-end tests, Playwright's browsers (WebKit is for the iPhone project):

```sh
pnpm i
pnpm --filter @rooster/web exec playwright install chromium webkit
```

**Run it locally:**

1. Copy `apps/server/.env.example` to `apps/server/.env`.
2. Set `ROOSTER_AUTH_SECRET` (`openssl rand -base64 48`; weak secrets make the server exit with code 78), and uncomment the block "Local development with the mock IdP".
3. Start the mock OIDC provider, **then** the dev servers (the server fetches the provider's discovery document at boot):

   ```sh
   pnpm dev:idp     # mock OIDC provider on :9400, signs in as dev@example.com
   pnpm dev         # API server on :3000 (tsx watch) + web on :5173 (Vite, proxies /api)
   ```

4. Open http://localhost:5173 and use **Dev login**.

To sign in as someone else next time (for collaboration features):

```sh
curl -X POST localhost:9400/__next-user -H 'content-type: application/json' \
     -d '{"email":"bob@example.com","name":"Bob"}'
```

Other useful commands:

```sh
pnpm --filter @rooster/cli dev -- ls     # run the CLI from source (--server / ROOSTER_SERVER)
pnpm --filter @rooster/cli dev           # with no arguments on a terminal: the TUI
pnpm build                               # every package; web → apps/web/dist, server → apps/server/dist
pnpm db:generate                         # a Drizzle migration from schema changes (+ STRICT post-processing)
node apps/web/scripts/render-icons.mjs   # regenerate the favicon, logos and app icons from src/ui/brand.ts
```

## Repository layout

| Path | What |
|---|---|
| `apps/server` | The Hono API server: auth, services (all authorisation lives here), SQLite through Drizzle, jobs, push, mail, MCP. |
| `apps/web` | The React SPA and PWA, with its Playwright e2e tests in `apps/web/e2e`. |
| `apps/cli` | The `rooster` CLI, its TUI and the stdio MCP server. Uses only the public API. |
| `packages/core` | Pure TypeScript shared by everything: ordering, dates and the natural-language parser, recurrence, reducers, zod schemas. |
| `packages/api-client` | The typed API client; `schema.d.ts` is generated from the server's OpenAPI document. |
| `packages/i18n` | English and Swedish message catalogs. |
| `packages/tokens` | The design tokens. |
| `packages/mcp` | The MCP tools shared by `rooster mcp` and `/mcp`. |
| `docs/` | The spec, ADRs, user guide, operator guide and screenshots. |

[`AGENTS.md`](AGENTS.md) maps every important module.

## How work is organised

- **The specification is the source of truth:** [`docs/spec/`](docs/spec/). When documents disagree, the precedence is **00 > 05 > 06 > 02 > 03 > others**. The decisions in [00](docs/spec/00-overview.md) (D-xx) are binding.
- **Phases and work packages** are in [09](docs/spec/09-phases.md), each with acceptance criteria (AC-x.y). Implement the scope of one work package at a time; the backlog there is specified but not scheduled.
- **ADRs** (`docs/adr/NNNN-title.md`, numbered in sequence) record decisions made during implementation: when the spec is silent, when you deviate from it, or when you settle a detail other contributors must follow. If the spec is silent, choose what fits "the list is a text editor" and common task-manager conventions best, and write the ADR. Flag every spec conflict in the PR description.
- **Commits and PR titles** follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(list): …`, `fix(sync): …`, `docs: …`.
- **CHANGELOG.md** follows [Keep a Changelog](https://keepachangelog.com/). Add user-visible changes under `[Unreleased]`, and list **every migration** with what it does.
- **AGENTS.md is kept current** in the same PR: a new module or directory, command, env var, convention, or a completed phase updates it.
- A PR description names the work package, the FR, AC and D IDs it covers, deviations and ADRs, screenshots for UI changes, and how you verified it.

## Tests and quality gates

Tests are part of the work. Name acceptance tests after their criterion (`AC-4.2 …`).

| Command | What it checks |
|---|---|
| `pnpm test` | Vitest, every project. |
| `pnpm test:coverage` | The same with the coverage gate (`packages/core` must stay ≥ 95 %). Run it unfiltered: the coverage globs are repo-relative. |
| `pnpm typecheck` | TypeScript, strict, every package. |
| `pnpm lint` / `pnpm format` | Biome (check / fix). |
| `pnpm i18n:check` | English–Swedish parity, valid ICU messages, no unused keys. |
| `pnpm gen:api` | Emits `apps/server/openapi.json` and regenerates `packages/api-client/src/schema.d.ts`. Never edit `schema.d.ts` by hand; CI fails when either file is stale. |
| `pnpm build && pnpm bundle:check` | The initial JavaScript for My tasks stays ≤ 500 KB gzip (ADR 0016, ADR 0052). |
| `pnpm --filter @rooster/cli smoke` | The built CLI against an in-memory server. |
| `pnpm e2e` | Playwright: the mock IdP, a fresh server and Vite are started for you. |

**The authorisation matrix** (`apps/server/test/authz.matrix.test.ts`) enumerates every OpenAPI route. A new route without a row there fails the suite.

**End-to-end tests** share ports 9400, 3181, 5181 and 3182, so never run two suites at once. When several checkouts may run the suite on one machine, serialise on the lock:

```sh
flock /tmp/rooster-e2e.lock pnpm --filter @rooster/web exec playwright test e2e/list.spec.ts
```

The projects are `chromium` (desktop), `mobile` (iPhone 15, WebKit) and `mobile-android` (Pixel 8) for `*.mobile.spec.ts`, and `pwa` / `pwa-update` for `*.pwa.spec.ts`, which run against the production build.

**The whole pipeline** is `pnpm run ci` ([`scripts/ci.sh`](scripts/ci.sh)). Note `pnpm run ci`: plain `pnpm ci` is pnpm's own command. It runs, in order: a frozen-lockfile install, lint, typecheck, `pnpm audit --prod --audit-level high` (a high or critical advisory fails), the gitleaks secret scan (`scripts/secret-scan.sh`, using the binary or its container), the i18n check, unit tests with coverage, the API client freshness check, the build, the bundle budget, the CLI smoke test and e2e. `pnpm run ci --with-docker` also builds the image and smoke-tests it (`scripts/docker-smoke.sh`).

## Conventions

The full list is in [AGENTS.md](AGENTS.md#hard-rules). The ones that catch people most often:

- **Authorisation only in services.** Routes never query the database; every service method takes an actor and checks access.
- **The server computes ordering keys.** Clients send `{beforeId, afterId}` intents. No integer positions, no `localeCompare` sorting.
- **Every list mutation goes through the client's mutation pipeline** (optimistic reducer from `packages/core`, outbox, `Idempotency-Key`). Settings and admin screens are online-only.
- **Floating dates are `YYYY-MM-DD` strings.** Never turn a due date into a JS `Date` to compare it.
- **No hard-coded UI strings** and **no hard-coded design values**: use the semantic tokens and Tailwind theme classes (Tailwind's default palette is removed, so off-token classes silently do nothing). Sizes are rem. Every new component gets an entry in the kitchen sink at `/_dev/ui`.
- **Keyboard parity:** every pointer action has a keyboard path, registered in `apps/web/src/keymap.ts`. **No modals** for everyday actions: inline editing and anchored popovers.
- **Migrations are append-only.** Never edit a merged migration. Generate schema migrations with `pnpm db:generate`; hand-written ones (FTS, triggers, pragmas only) with `pnpm --filter @rooster/server exec drizzle-kit generate --custom --name <name>`, statements separated by `--> statement-breakpoint`.
- **Dependencies:** don't add one whose purpose overlaps an existing one (the stack table is in [04 §2](docs/spec/04-architecture.md)), and justify each new one in the PR. Native modules need entries in the server's or CLI's `tsdown.config.ts` and in `docker/Dockerfile`.
- TypeScript strict and ESM everywhere, named exports, kebab-case files. Comments explain *why*.

## Translations (i18n)

- **Every string exists in English and Swedish**, in `packages/i18n/locales/{en,sv}/<namespace>.json`, as ICU messages (plurals as `{count, plural, one {# task} other {# tasks}}`).
- **Swedish must be natural**, not word-for-word. Use the app's established terms; the glossary is in [03 §4](docs/spec/03-design-system.md#4-content--voice) (uppgift, grupp, inkorg, deluppgift, tagg, ansvarig, Allas uppgifter, …). Sentence case in both languages.
- **A new namespace** needs the JSON file in every locale, plus an entry in `packages/i18n/src/core.ts` and in both `catalog-en.ts` and `catalog-sv.ts`.
- `pnpm i18n:check` must pass.

## Documentation

- **The user guide** is Markdown in [`docs/guide/en/`](docs/guide/en/) and [`docs/guide/sv/`](docs/guide/sv/), one file per page; [`docs/guide/pages.json`](docs/guide/pages.json) lists the pages in order with their slugs and titles. Change both languages together, link between pages with relative `./slug.md` links, and embed screenshots as `../../screenshots/<file>.png` with alt text. The app renders the guide at `/help` at build time, so a change shows up in the next build.
- **The keyboard page is generated** from the keymap registry: run `pnpm docs:keyboard` after changing a shortcut. Never edit `docs/guide/*/keyboard.md` by hand; CI fails when it no longer matches `keymap.ts`.
- **The operator guide** is [`docs/operator.md`](docs/operator.md). Update it with every new env var, proxy route or operational change (and `.env.example` too).

### Screenshots

The guide's and the README's screenshots in [`docs/screenshots/`](docs/screenshots/) are generated, never edited by hand. Regenerate them deliberately when a screen they show changes (CI doesn't run this):

```sh
pnpm docs:screenshots                               # everything, about 1–2 minutes
DOCS_SHOTS=inbox,palette pnpm docs:screenshots      # only these (other images are kept)
pnpm docs:screenshots --project=phone-light         # extra arguments go to Playwright
```

- It needs the Playwright browsers (`chromium` and `webkit`, see Prerequisites) and uses the e2e ports, so it waits for the shared lock (`/tmp/rooster-e2e.lock`) while another Playwright run is going.
- It starts the mock IdP, a server on a fresh temporary data directory and Vite, then seeds **Kestrel Lane**, a fictional five-person design studio, through the public API (`scripts/docs/screenshots/seed.setup.ts`): three organisations, groups, tags, about 50 tasks with dates relative to today, subtasks, recurring tasks, reminders, comments with mentions, followers, generated avatars and attachments, notifications, a calendar feed, a token and a CLI login. Keep it synthetic: no real people, companies or addresses.
- The shots are in `scripts/docs/screenshots/{desktop,phone}.shots.ts`: desktop at 1440 × 900 (Chromium) and phone as an iPhone 15 (WebKit), in English. Each file is `docs/screenshots/<name>.<desktop|phone>.<light|dark>.png`, quantised to a palette PNG by `scripts/docs/optimize-screenshots.mjs`. The dark projects skip themselves while the app has no dark theme.
- To keep re-runs from churning the images, the local origin is shown as `https://rooster.example.com`, client addresses are fixed documentation addresses, and random codes (the device code, token prefixes) are replaced with fixed samples. Relative dates ("Today", "Mon") and "just now" still follow the day you run it.
- A new screen: add a `run.take('<name>', …)` step to the right spec, call `shot()`, and reference the file from the guide.

## Reporting security issues

Please **don't open a public issue** for a vulnerability. Report it privately through GitHub's private vulnerability reporting on [201works/rooster](https://github.com/201works/rooster/security) (Security → Report a vulnerability).

Security-relevant changes (authentication, grants and authorisation, uploads, outbound requests, the CLI's credential and file handling) also get an independent security review before they are considered done; ADR 0040 records the first round, and the Phase 11 audit is tracked in `docs/security/`.
