<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/icons/wordmark-dark.svg">
    <img alt="rooster" src="apps/web/public/icons/wordmark.svg" height="56">
  </picture>
</h1>

A self-hosted, keyboard-first task manager.

- **Groups:** personal, drag-sortable groups like *Today*, *Prio* and *Upcoming*, in exactly the order you choose.
- **Inline everything:** Enter for a new task, `fri` in the title for a due date, drag and drop to reorder. No dialogs.
- **Smart views:** Today, Next 7 days, Overdue and No date, with counts in the sidebar.
- **Search and command palette:** Ctrl/Cmd+K finds tasks (prefix and full-text) and runs any action.
- **Detail pane:** a side pane for descriptions (Markdown), subtasks and tags.
- **Organisations:** keep private and business tasks apart.
- **Sign-in:** OIDC (Google, Keycloak, Authentik and others).
- **Mobile:** an installable PWA that reads offline and queues edits.
- **Your data:** JSON and Markdown export per org, a 30-day Trash, and nightly backups.
- **Hosting:** one Docker container and one SQLite volume.

**Status:** v1.1, the daily-use release. Collaboration (assignees, comments, notifications), the CLI, TUI and MCP server, recurrence, attachments and the iCal feed follow; see the [phases](docs/spec/09-phases.md) and the [changelog](CHANGELOG.md).

## Quick start (Docker Compose)

You need Docker, a domain with HTTPS (a reverse proxy such as Caddy, Traefik or nginx), and a Google or OIDC client for sign-in.

1. Get the compose file and the configuration template:

   ```sh
   mkdir rooster && cd rooster
   curl -fsSLO https://raw.githubusercontent.com/201works/rooster/main/compose.yaml
   curl -fsSL https://raw.githubusercontent.com/201works/rooster/main/apps/server/.env.example -o .env
   ```

2. Edit `.env`. The required values are:

   ```env
   ROOSTER_BASE_URL=https://rooster.example.com
   ROOSTER_AUTH_SECRET=        # openssl rand -base64 48
   ROOSTER_ADMIN_EMAILS=you@example.com
   # plus one sign-in provider, e.g.
   ROOSTER_GOOGLE_CLIENT_ID=…
   ROOSTER_GOOGLE_CLIENT_SECRET=…
   ```

   [`docs/oidc-setup.md`](docs/oidc-setup.md) walks through Google, Authentik and Keycloak. The redirect URI to register is `${ROOSTER_BASE_URL}/api/auth/callback/<provider id>`.

3. Start it:

   ```sh
   docker compose up -d
   docker compose logs -f rooster   # a config problem prints every issue and exits with code 78
   ```

4. Point your reverse proxy at `127.0.0.1:3000` (snippets for [Caddy](docker/proxy/Caddyfile), [nginx](docker/proxy/nginx.conf) and [Traefik](docker/proxy/traefik-labels.yaml)), open `ROOSTER_BASE_URL` and sign in with an admin email.

5. On a phone, open the same URL and use *Add to Home Screen* (iOS) or *Install app* (Android). The installed app signs in separately on iOS.

Press `?` in the app for every keyboard shortcut.

### Upgrades and backups

- The image is tagged `x.y.z`, `x.y` and `x`. `compose.yaml` pins the major version (`:1`); upgrade with `docker compose pull && docker compose up -d`. Migrations run automatically, after a pre-migration backup.
- Nightly snapshots land in the volume's `backups/` directory (7 daily, 4 weekly), and admins can download them under Admin → Backups. Copy `/data/backups` off the host with restic, borg or rclone. The restore steps are in [operations §7](docs/spec/08-operations.md#7-backups--restore).
- Every configuration variable is listed in [operations §3](docs/spec/08-operations.md#3-configuration-env).

## Command line

`rooster` works with your tasks from a terminal, scripts and CI. It talks to any rooster server over the public API.


**Sign in**
```sh
rooster login --server https://rooster.example.com   # opens /device; approve in any browser, even on your phone
rooster login --no-browser --server …                 # headless: open the printed URL elsewhere
echo "$ROOSTER_PAT" | rooster login --with-token --server …   # CI, with a personal access token
rooster whoami                                         # who you are and what this login may do
```
On the approval page you choose which organisations and groups the CLI may read and write. `rooster logout` revokes the login.
- Credentials go to the OS keychain, or to `~/.config/rooster/credentials` (mode 0600) where there is none (`ROOSTER_KEYRING=off` forces the file).
- Profiles live in `~/.config/rooster/config.toml` (`--profile work`).
- `ROOSTER_SERVER`, `ROOSTER_TOKEN`, `ROOSTER_ORG` and `ROOSTER_PROFILE` override the file, and `NO_COLOR` turns colour off.

**Everyday use**
```sh
rooster                       # My tasks (same as rooster ls)
rooster today | rooster week | rooster ls overdue
rooster add "Pay invoice tom #finance >Prio"   # quote it: dates, #tags, >Group and @person are understood
rooster done 42 57            # tasks by number; also personal#42, an ID prefix, or @last
rooster mv 42 --group Prio --bottom
rooster show 42 | rooster edit 42 --editor | rooster tag 42 +urgent -later
rooster ls --json | jq -r '.tasks[].seq' | rooster done -
```
Every command takes `--json` (API fields) and `--quiet` (refs only).

**Tokens for scripts:** `rooster token create ci --scope tasks:write --org personal --write-group personal/Prio --expires 30d` prints the token once. It can't have more access than the login that creates it. `rooster apps ls` lists everything connected to your account; Settings → Security → Connected apps does the same in the browser.

**Shell completion:** `rooster completion bash >> ~/.bashrc` (also `zsh`, `fish`, `powershell`). Group and tag names complete too.

**Exit codes:** 0 ok · 1 unexpected · 2 usage · 3 auth or permission · 4 not found or ambiguous · 5 conflict or validation · 6 network.

## Development

Node 24 and pnpm (via corepack):

```sh
pnpm i
cp apps/server/.env.example apps/server/.env   # uncomment the "Local development with the mock IdP" block
pnpm dev:idp                                   # mock OIDC provider on :9400
pnpm dev                                       # server :3000 + web :5173
```

Open http://localhost:5173 and use *Dev login*. `pnpm ci` runs the whole pipeline. [`AGENTS.md`](AGENTS.md) has the repository map, commands and rules.

## Documentation

| Doc | |
|---|---|
| [Overview & decisions](docs/spec/00-overview.md) | [Product requirements](docs/spec/01-product.md) |
| [UX & interaction](docs/spec/02-ux-interaction.md) | [Design system "Coop"](docs/spec/03-design-system.md) |
| [Architecture](docs/spec/04-architecture.md) | [Data model](docs/spec/05-data-model.md) |
| [API](docs/spec/06-api.md) (live docs at `/api/docs`) | [CLI, TUI & MCP](docs/spec/07-cli.md) |
| [Operations](docs/spec/08-operations.md) | [Phases](docs/spec/09-phases.md) |
| [Quality](docs/spec/10-quality.md) | [Decisions (ADRs)](docs/adr/) |
| [Sign-in setup](docs/oidc-setup.md) | [Agent rules](AGENTS.md) |
