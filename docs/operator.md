# Operator guide

This guide is for people who run a rooster instance: installing it, configuring it, putting it behind a reverse proxy, backing it up, upgrading it and keeping an eye on it. The user guide (in the app at `/help`, and in [`docs/guide/`](guide/)) covers everyday use.

rooster is **one container, one volume and one env file**. After `docker compose up -d`, nothing has to be run by hand: the server migrates its database, backs itself up and runs its own jobs.

- [Requirements](#requirements)
- [Install with Docker Compose](#install-with-docker-compose)
- [Configuration](#configuration)
- [Sign-in and who may use the instance](#sign-in-and-who-may-use-the-instance)
- [Reverse proxy](#reverse-proxy)
- [Backups and restore](#backups-and-restore)
- [Off-site backups](#off-site-backups)
- [Upgrades](#upgrades)
- [Monitoring](#monitoring)
- [Security operations](#security-operations)
- [Attachment storage quota](#attachment-storage-quota)
- [Troubleshooting](#troubleshooting)

## Requirements

| What | Notes |
|---|---|
| Docker with Compose v2 | The image is published to `ghcr.io/201works/rooster` for `linux/amd64`. On another architecture (for example arm64), build it from the repository: `compose.yaml` has a `build` section, so `docker compose build` works. |
| A **local** filesystem for the volume | rooster keeps its data in SQLite in WAL mode. NFS and SMB break SQLite's locking: use a local disk (a named Docker volume or a local bind mount). |
| A domain with HTTPS | TLS is your reverse proxy's job (Caddy, nginx, Apache, Traefik). Session cookies are `Secure` and `__Host-` prefixed on https, and installable apps and push notifications need https. |
| One sign-in provider | Google or any OpenID Connect provider. rooster has no passwords. See [`oidc-setup.md`](oidc-setup.md). |
| Resources | About 100–150 MB of RAM. The image is about 280 MB (the budget is 350 MB, ADR 0048). Disk use is the database plus attachments plus backups. |
| Optional: SMTP | For invite emails, notification emails and the daily digest. |
| Optional: S3-compatible storage | For attachments, instead of the volume. |

## Install with Docker Compose

1. Get the compose file and the configuration template:

   ```sh
   umask 077   # .env will hold the auth secret and provider credentials: owner-only
   mkdir rooster && cd rooster
   curl -fsSLO https://raw.githubusercontent.com/201works/rooster/main/compose.yaml
   curl -fsSL https://raw.githubusercontent.com/201works/rooster/main/apps/server/.env.example -o .env
   chmod 600 .env
   ```

   Keep `.env` readable by its owner only (`chmod 600 .env`, also for an existing install) before you put secrets in it: under a shared path such as `/srv`, another local account could otherwise read the auth secret and every credential added later.

   `compose.yaml` runs `ghcr.io/201works/rooster:1` (the major version is pinned), mounts the named volume `rooster-data` at `/data`, sets `ROOSTER_TRUST_PROXY=true`, and publishes port 3000 on `127.0.0.1` only. Your reverse proxy connects to it there, or you attach the service to the proxy's Docker network instead.

2. Edit `.env`. The required values are:

   ```env
   ROOSTER_BASE_URL=https://rooster.example.com
   ROOSTER_AUTH_SECRET=        # openssl rand -base64 48
   ROOSTER_ADMIN_EMAILS=you@example.com
   # plus at least one sign-in provider, for example:
   ROOSTER_GOOGLE_CLIENT_ID=…
   ROOSTER_GOOGLE_CLIENT_SECRET=…
   ```

   Delete or comment out the template's `ROOSTER_DATA_DIR=./data` line, or leave it: `compose.yaml` sets `ROOSTER_DATA_DIR=/data`, which wins.

3. Start it and watch the log:

   ```sh
   docker compose up -d
   docker compose logs -f rooster
   ```

   An invalid configuration prints **every** problem at once and exits with code **78** (`EX_CONFIG`). Fix the listed variables and start again. A healthy start logs `rooster listening` with the version and git SHA.

4. Point your reverse proxy at `127.0.0.1:3000` ([Reverse proxy](#reverse-proxy)).

5. Open `ROOSTER_BASE_URL` and sign in with an address from `ROOSTER_ADMIN_EMAILS`. The first sign-in creates your account and your personal organisation. As an instance admin you see **Admin** in the user menu: users, the allowlist, backups and push keys.

On first boot the server creates `/data/rooster.db`, the `backups/` and `attachments/` directories, the instance ID, and (unless you set them) the Web Push keys.

### What is in `/data`

```
/data/
  rooster.db  rooster.db-wal  rooster.db-shm   # the database (SQLite, WAL mode)
  attachments/                                 # attachment files and thumbnails (local storage)
  backups/                                     # rooster-*.db, manual-*.db, pre-migrate-*.db
  tmp/                                         # uploads in flight; emptied at every start
```

New files are created `0600` and directories `0700` (the server runs with umask `0077` as the image's non-root user, UID 65532).

## Configuration

All configuration is environment variables, normally in `.env`. [`apps/server/.env.example`](../apps/server/.env.example) is the annotated template, and `apps/server/src/config.ts` is the source of truth.

- **Secrets from files:** every variable also accepts a `<NAME>_FILE` form. When it is set, the value is read from that file (one trailing newline is stripped). Use it with Docker secrets, for example `ROOSTER_AUTH_SECRET_FILE=/run/secrets/rooster_auth_secret`.
- **Empty values count as unset**, so blank lines in `.env` are harmless.
- **Booleans** accept `true`/`false`, `1`/`0` and `yes`/`no`; the `on`/`off` switches accept those too.
- Invalid values, or a missing partner variable (for example `ROOSTER_SMTP_URL` without `ROOSTER_MAIL_FROM`), stop the server with exit code 78 and a list of every problem.

### Required

| Variable | Default | Description |
|---|---|---|
| `ROOSTER_BASE_URL` | — | The public URL people use, e.g. `https://rooster.example.com` (scheme, host, port; a trailing slash is removed). Used for sign-in callbacks, cookies, links in emails and feeds, the OAuth issuer and the CSRF origin check. |
| `ROOSTER_AUTH_SECRET` | — | At least 32 characters. Generate with `openssl rand -base64 48`. Refused if it still contains `change-me` or has fewer than 10 distinct characters. See [Rotating the auth secret](#rotating-the-auth-secret). |
| `ROOSTER_ADMIN_EMAILS` | — | Comma-separated. These people may always sign in and are instance admins. |

### Sign-in and access

At least one provider is required: Google, or one entry in `ROOSTER_OIDC_PROVIDERS`, or both.

| Variable | Default | Description |
|---|---|---|
| `ROOSTER_GOOGLE_CLIENT_ID` / `ROOSTER_GOOGLE_CLIENT_SECRET` | — | A Google OAuth client. Set both or neither. |
| `ROOSTER_OIDC_PROVIDERS` | `[]` | A JSON array of generic OIDC providers: `{id, name, discoveryUrl, clientId, clientSecret, scopes?, trustEmail?}`. IDs are lowercase and unique (`google` is reserved). `trustEmail` (default `false`) lets a first sign-in through this provider join an existing account with the same verified email. Details in [`oidc-setup.md`](oidc-setup.md). |
| `ROOSTER_ALLOWED_EMAILS` | — | Comma-separated extra addresses that may sign in. |
| `ROOSTER_ALLOWED_DOMAINS` | — | Comma-separated domains whose addresses may sign in, e.g. `northwind.example`. |

### Network and proxy

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | The HTTP port inside the container. |
| `ROOSTER_TRUST_PROXY` | `false` | Honour `X-Forwarded-For` and `X-Forwarded-Proto`. Set it behind a reverse proxy (`compose.yaml` does). |
| `ROOSTER_TRUSTED_PROXY_HOPS` | `1` | With `ROOSTER_TRUST_PROXY`: how many trusted proxies append to `X-Forwarded-For` (1 for one proxy, 2 for a CDN in front of it). The client address is that many entries from the right; anything further left is client-supplied and ignored. It feeds the per-IP rate limits and the session list. |

### Email

Without SMTP, email options are hidden in the app and invites are links to copy.

| Variable | Default | Description |
|---|---|---|
| `ROOSTER_SMTP_URL` | — | `smtp://` (STARTTLS when offered) or `smtps://` (TLS), e.g. `smtps://user:pass@smtp.example.com:465`. Enables invite emails, notification emails (immediate or a 15-minute batch) and the daily digest. |
| `ROOSTER_MAIL_FROM` | — | Required with `ROOSTER_SMTP_URL`: `Rooster <rooster@example.com>` or a bare address. |

To check the setup, use **Send test email** in Admin → System. It sends to your own address and waits for the mail server's answer.

**Through the host's own mail server** (Postfix on the Docker host): point rooster at the host, e.g. `ROOSTER_SMTP_URL=smtp://host.docker.internal:25` with `extra_hosts: ["host.docker.internal:host-gateway"]` in `compose.yaml`, and let Postfix relay for the Docker network (`mynetworks` includes `172.16.0.0/12`; with OpenDKIM, add it to `TrustedHosts` too, so the mail gets signed). Postfix has to listen on the Docker bridge (`inet_interfaces = all`, or add the bridge address); it then relays only for `mynetworks`, so it is no open relay. Turn on TLS for Postfix's own deliveries, or Gmail and others mark the mail as not encrypted:

```
sudo postconf -e 'smtp_tls_security_level = may' 'smtp_tls_CAfile = /etc/ssl/certs/ca-certificates.crt' 'smtp_tls_loglevel = 1'
sudo systemctl reload postfix
```


### Web Push

| Variable | Default | Description |
|---|---|---|
| `ROOSTER_VAPID_PUBLIC` / `ROOSTER_VAPID_PRIVATE` | generated | base64url P-256 keys (65 and 32 bytes), e.g. from `npx web-push generate-vapid-keys`. Set both or neither. Without them a key pair is generated at first boot and kept in the database. Keys from the environment cannot be regenerated from Admin. |
| `ROOSTER_VAPID_SUBJECT` | `mailto:<first admin email>` | The push services' contact for this server: a `mailto:` or `https://` URL. |

### Agents and OAuth

rooster is its own OAuth 2.1 authorization server for AI agents and other apps (issuer `<ROOSTER_BASE_URL>/api/auth`) and serves a remote MCP endpoint at `/mcp`.

| Variable | Default | Description |
|---|---|---|
| `ROOSTER_OAUTH_DEVICE` | `first-party` | Who may use the OAuth device grant (sign-in with a code typed on `/device`, for machines without a browser): `first-party` lets only rooster's own CLI, `all` also any app with a Client ID Metadata Document that lists the grant (always shown as Unverified with its domain), `off` no one (the CLI then falls back to its older login). With `all`, the authorization server metadata advertises the device endpoint. |
| `ROOSTER_OAUTH_DCR` | `off` | `on` enables OAuth Dynamic Client Registration for older MCP clients that don't support Client ID Metadata Documents. Such apps show as "Unverified app" on the consent screen. Registration is rate-limited per IP. |
| `ROOSTER_AGENT_DISCOVERY` | `on` | `off` hides the best-effort discovery documents: the MCP Server Card (`/mcp/server-card`, `/.well-known/mcp/server-card.json`), `/.well-known/ai-catalog.json`, the agent-skills index and `SKILL.md`, and `/llms.txt`. The OAuth metadata that MCP clients need is served either way. |

### Attachments and storage

| Variable | Default | Description |
|---|---|---|
| `ROOSTER_UPLOAD_MAX_MB` | `25` | The largest attachment, in MB (avatars are limited to 2 MB). Keep your proxy's body limit above it. |
| `ROOSTER_USER_STORAGE_MB` | `1024` | Attachment storage per user, in MB. `0` means no quota. See [Attachment storage quota](#attachment-storage-quota). |
| `ROOSTER_S3_BUCKET` | — | Setting a bucket (with both keys) stores new attachments and avatars in S3-compatible storage instead of `/data/attachments`. Files stored earlier stay readable where they are. Downloads redirect to presigned URLs valid for 60 seconds. |
| `ROOSTER_S3_ACCESS_KEY_ID` / `ROOSTER_S3_SECRET_ACCESS_KEY` | — | Required with `ROOSTER_S3_BUCKET`. |
| `ROOSTER_S3_ENDPOINT` | — | The only host S3 requests go to. Leave it empty for AWS S3 (the region picks the host); set it for MinIO, Cloudflare R2, Garage and the like. |
| `ROOSTER_S3_REGION` | `us-east-1` | |
| `ROOSTER_S3_FORCE_PATH_STYLE` | `false` | Path-style URLs (`<endpoint>/<bucket>/<key>`), which MinIO and most self-hosted stores need. |

### Backups

| Variable | Default | Description |
|---|---|---|
| `ROOSTER_BACKUP_CRON` | `0 3 * * *` | When the nightly snapshot runs (cron syntax, in the server's `TZ`), or `off`. |
| `ROOSTER_BACKUP_KEEP_DAILY` | `7` | How many scheduled snapshots to keep. |
| `ROOSTER_BACKUP_KEEP_WEEKLY` | `4` | How many Sunday snapshots (UTC) to keep in addition. |

### Monitoring and logging

| Variable | Default | Description |
|---|---|---|
| `ROOSTER_LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `ROOSTER_METRICS_TOKEN` | — | Reserved for a bearer-protected Prometheus `/metrics` endpoint (at least 16 characters). The server accepts the variable, but this version does not serve `/metrics` yet. |
| `TZ` | `UTC` | The server's timezone. It affects log timestamps and when `ROOSTER_BACKUP_CRON` fires; everything users see follows each user's own timezone. |

### Advanced and internal

| Variable | Default | Description |
|---|---|---|
| `ROOSTER_DATA_DIR` | `/data` | Where the database, attachments and backups live. Leave it at `/data` in Docker. |
| `ROOSTER_WEB_DIR` | the image's web build | The directory the web app is served from. Only for custom builds. |
| `ROOSTER_GIT_SHA` | set by the image build | Shown in `/api/v1/meta` and Admin → System. |
| `ROOSTER_VALIDATE_RESPONSES` | `false` | **Test only.** Checks every API response against the OpenAPI document. Never set it in production. |

## Sign-in and who may use the instance

rooster has no passwords: people sign in with Google or an OpenID Connect provider (Keycloak, Authentik, Authelia, Zitadel, Microsoft Entra ID and others). [`oidc-setup.md`](oidc-setup.md) walks through Google, Authentik and Keycloak. The redirect URI to register is always:

```
${ROOSTER_BASE_URL}/api/auth/callback/<provider id>      # Google: …/callback/google
```

**rooster decides who may sign in, not the provider.** A person may sign in when any of these holds:

- their address is in `ROOSTER_ADMIN_EMAILS` (they are also instance admins);
- their address or domain is in `ROOSTER_ALLOWED_EMAILS` / `ROOSTER_ALLOWED_DOMAINS`, or on the allowlist in **Admin → Allowlist**;
- they have a valid invite to an organisation (org owners create invites, as links or, with SMTP, by email).

The provider must report a verified email (`email_verified: true`). Everyone else sees a friendly "not invited" page. Admins can disable a user in **Admin → Users**, which signs them out everywhere.

## Reverse proxy

rooster listens on plain HTTP; the proxy terminates TLS. Ready-made snippets are in [`docker/proxy/`](../docker/proxy/): [Apache](../docker/proxy/apache.conf), [nginx](../docker/proxy/nginx.conf), [Caddy](../docker/proxy/Caddyfile) and [Traefik](../docker/proxy/traefik-labels.yaml).

What the proxy must do:

1. **Pass everything to rooster.** Besides the app and `/api/…`, rooster serves `/ical/<token>.ics` (calendar feeds), `/unsubscribe/<token>` (email links), `/mcp` and `/mcp/server-card` (remote MCP), `/.well-known/*` (OAuth metadata and agent discovery), `/llms.txt`, and `/healthz` and `/readyz`. A catch-all `location /` or `ProxyPass /` covers all of them; if you route by path, list each one.
2. **Set the client address correctly.** Set `ROOSTER_TRUST_PROXY=true`, and make sure the proxy does **not** pass on a client-supplied `X-Forwarded-For` chain: rooster takes the right-most `ROOSTER_TRUSTED_PROXY_HOPS` entries as the client address, for rate limits and the session list.
   - nginx: `proxy_set_header X-Forwarded-For $remote_addr;` (not `$proxy_add_x_forwarded_for`).
   - Apache: `RequestHeader unset X-Forwarded-For early`; `mod_proxy` then adds the real peer.
   - Caddy ignores the incoming header unless `trusted_proxies` is set.
   - Also send `X-Forwarded-Proto` (https).
3. **Don't buffer the streams.** Live updates use Server-Sent Events on `/api/v1/events`; remote MCP answers on `/mcp` may stream too. Turn off buffering and compression for both, and allow long-lived connections (an hour for `/api/v1/events`; ≥ 60 s at the very least). rooster also sends `X-Accel-Buffering: no` on the SSE route.
4. **Allow uploads.** Attachments are up to `ROOSTER_UPLOAD_MAX_MB` (25 MB) plus multipart framing, so allow request bodies of **at least 30 MB** (raise it together with `ROOSTER_UPLOAD_MAX_MB`). rooster enforces its own, tighter limits on every other route (64 KB on `/api/auth`, 1 MB on the JSON API).
5. **Leave rooster's security headers alone.** It sends its own CSP, HSTS, `X-Frame-Options` and `Referrer-Policy`.

**nginx** (excerpt of [`nginx.conf`](../docker/proxy/nginx.conf)):

```nginx
client_max_body_size 30m;

location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;  # never pass on a client-supplied chain
  proxy_set_header X-Forwarded-Proto $scheme;
}

location /api/v1/events {          # the same for "location = /mcp", with proxy_read_timeout 10m
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 1h;
}
```

**Apache httpd 2.4** (excerpt of [`apache.conf`](../docker/proxy/apache.conf); needs `mod_proxy`, `mod_proxy_http`, `mod_headers`, `mod_setenvif`):

```apache
ProxyPreserveHost On
RequestHeader set X-Forwarded-Proto "https"
RequestHeader unset X-Forwarded-For early

SetEnvIf Request_URI "^/api/v1/events" no-gzip=1
ProxyPass        /api/v1/events http://127.0.0.1:3000/api/v1/events flushpackets=on timeout=3600
ProxyPassReverse /api/v1/events http://127.0.0.1:3000/api/v1/events
SetEnvIf Request_URI "^/mcp$" no-gzip=1
ProxyPass        /mcp http://127.0.0.1:3000/mcp flushpackets=on timeout=600
ProxyPassReverse /mcp http://127.0.0.1:3000/mcp

LimitRequestBody 31457280

ProxyPass        / http://127.0.0.1:3000/
ProxyPassReverse / http://127.0.0.1:3000/
```

The specific `ProxyPass` lines must come before the catch-all `/`.

**Caddy** streams `text/event-stream` correctly by default; `reverse_proxy 127.0.0.1:3000` is enough (the shipped Caddyfile also caps bodies at 30 MB). **Traefik** needs no special SSE configuration; raise `respondingTimeouts` if you have customised them.

## Backups and restore

### What rooster does by itself

- **Nightly snapshots.** At `ROOSTER_BACKUP_CRON` (03:00 by default) the server writes a consistent copy of the database with SQLite's `VACUUM INTO` to `/data/backups/rooster-<timestamp>.db`. It keeps the newest `ROOSTER_BACKUP_KEEP_DAILY` (7) snapshots plus the newest `ROOSTER_BACKUP_KEEP_WEEKLY` (4) Sunday ones.
- **Before every update.** When the server starts with a different version than last time, or with pending migrations, it first writes `backups/pre-migrate-<timestamp>.db` (shown as "Before update" in Admin). Upgrades and downgrades are both covered; a brand-new database is not backed up (ADR 0023).
- **On demand.** **Admin → Backups → Back up now** writes `manual-<timestamp>.db`. The newest 10 manual and 10 pre-update snapshots are kept.
- **Download.** Admin → Backups lists every snapshot with a download link.

A database snapshot plus the `attachments/` directory is a **complete backup** (with S3 storage, the bucket holds the attachments instead). Snapshots live in the same volume as the database, so they protect against mistakes and bad upgrades, not against losing the disk: copy them off the host ([Off-site backups](#off-site-backups)).

### Restore

The image is distroless (no shell), so use a throwaway container on the same volume. Compose names the volume `<project>_rooster-data`, for example `rooster_rooster-data`; `docker volume ls` shows it.

1. Stop rooster: `docker compose stop rooster`.
2. Copy the snapshot over the database and remove the WAL files:

   ```sh
   docker run --rm -v rooster_rooster-data:/data alpine sh -c '
     cp /data/backups/rooster-2026-10-10T03-00-00-000Z.db /data/rooster.db &&
     rm -f /data/rooster.db-wal /data/rooster.db-shm &&
     chown 65532:65532 /data/rooster.db && chmod 600 /data/rooster.db'
   ```

   For a downloaded snapshot, mount its directory too (`-v "$PWD":/restore`) and copy from `/restore/…`. With local attachment storage, restore `attachments/` from the same point in time.
3. Start rooster: `docker compose start rooster`. If the snapshot is older than the running version, the migrations bring it forward (after a pre-update backup of the restored file). The search index is rebuilt automatically when it is out of step.

Users' installed apps keep queued offline edits; they are sent again after the restore and applied where the tasks still exist.

**Permissions:** if you upgraded from 1.0.0 or earlier, existing files may still be world-readable. Once, on the host: `chmod 700` the data and backups directories and `chmod 600` the `*.db*` files.

## Off-site backups

Copy `/data/backups` and `/data/attachments` off the host on a schedule with restic, borg or rclone. With a named volume, the files are under `docker volume inspect -f '{{.Mountpoint}}' rooster_rooster-data` on the host. Back up the snapshots, not the live `rooster.db` (a copy of a database in WAL mode taken while it is written to may be inconsistent). With S3 attachment storage, use the bucket's own versioning or replication for the files.

### Continuous replication with Litestream

For point-in-time restore, the optional overlay `compose.litestream.yaml` adds a [Litestream](https://litestream.io/) 0.5 sidecar. It shares the volume with rooster and replicates the database continuously to S3 or another supported target, so you lose at most seconds of changes instead of up to a day. It replicates the database only: keep backing up `attachments/` (or use S3 storage for them).

Set the bucket settings in the same `.env` that Compose reads. Put the two credentials in a separate file, `litestream.env` next to `compose.yaml` (`chmod 600 litestream.env`), never in `.env`: `compose.yaml` hands every variable of `.env` to the rooster container, and only the sidecar needs the keys to the replicas. Litestream expands all of them at runtime, so they never appear in the generated config. Compose refuses to start the overlay without `litestream.env`.

| Variable | Default | Description |
|---|---|---|
| `LITESTREAM_S3_BUCKET` | required | The bucket that receives the replica. |
| `LITESTREAM_S3_PATH` | `rooster` | The path inside the bucket. |
| `LITESTREAM_S3_REGION` | `us-east-1` | The bucket's region. |
| `LITESTREAM_S3_ENDPOINT` | empty | Empty for AWS. Set it for MinIO, Cloudflare R2, Garage and other S3-compatible stores; this also switches to path-style URLs. |
| `LITESTREAM_ACCESS_KEY_ID` | required | The access key, in `litestream.env`. |
| `LITESTREAM_SECRET_ACCESS_KEY` | required | The secret key, in `litestream.env`. |

Litestream takes a snapshot every 24 hours and keeps them for 7 days, so you can restore any point in the last week. The sidecar (`litestream/litestream:0.5.17`, pinned by digest) runs as the same unprivileged user as rooster and starts once rooster is healthy.

Start rooster with the overlay:

```sh
docker compose -f compose.yaml -f compose.litestream.yaml up -d
```

To restore the latest state, stop both containers, restore into a new file, swap it in, and start again. `litestream restore` refuses to overwrite an existing file, so it restores to `restored.db` first, and the old database is kept as `rooster.db.before-restore`:

```sh
docker compose -f compose.yaml -f compose.litestream.yaml stop rooster litestream
docker compose -f compose.yaml -f compose.litestream.yaml run --rm --no-deps --entrypoint sh litestream -c \
  'litestream restore -o /data/restored.db /data/rooster.db \
   && mv /data/rooster.db /data/rooster.db.before-restore \
   && rm -f /data/rooster.db-wal /data/rooster.db-shm \
   && mv /data/restored.db /data/rooster.db'
docker compose -f compose.yaml -f compose.litestream.yaml up -d
```

For a point in time, add `-timestamp 2026-10-09T12:00:00Z` after `litestream restore`. When rooster starts, its migrations bring an older snapshot forward, and it makes the restored file readable only by itself (0600). If it cannot (the file belongs to another account, for example after a restore run as root), it refuses to start and says so in the log: give the files back to the server's user with `chown -R 65532:65532` on the volume's directory, then start again.

rooster needs no setting change for Litestream. It already uses WAL mode, `busy_timeout=5000` and `synchronous=NORMAL`, and keeps SQLite's automatic checkpoints, which Litestream 0.5 detects. Turning automatic checkpoints off is only worth it under heavy write load, and it would let the WAL grow without bound if the sidecar stopped.

Don't run other tools that checkpoint the database while Litestream replicates. rooster's own nightly snapshots keep working alongside it.

## Upgrades

- Images are tagged `x.y.z`, `x.y` and `x` (and `latest`). `compose.yaml` pins the major version (`:1`), so you get features and fixes but no breaking changes.
- **Upgrade:**

  ```sh
  docker compose pull && docker compose up -d
  ```

  On start, the server writes the pre-update backup, applies any migrations, and then listens. Nothing else to run.
- **Read the [CHANGELOG](../CHANGELOG.md)** first: each release lists its migrations and any **Upgrade notes** (for example a new proxy route or body size).
- **Installed apps** notice the new version and show "New version available · Reload" plus an "Update" chip; they never reload while edits are waiting to be sent or someone is typing.
- **Downgrading:** migrations are forward-only. To go back across a migration, stop rooster, restore the `pre-migrate-*.db` that the newer version wrote when it first started ([Restore](#restore)), and start the older image. Changes made since the upgrade are lost.

## Monitoring

- **Health checks:** `GET /healthz` answers `200` while the process runs (liveness). `GET /readyz` answers `200` when the database responds and no migration is pending, `503` otherwise (readiness). The image's Docker `HEALTHCHECK` calls `/readyz` every 30 s, so `docker ps` shows `healthy`.
- **Logs:** JSON lines (pino) on stdout: `docker compose logs -f rooster`, or ship them to Loki or similar. Set `ROOSTER_LOG_LEVEL=debug` while investigating. Logs never contain invite tokens, calendar tokens, search text or SQL parameter values.
- **Version:** `GET /api/v1/meta` (no sign-in needed) shows the version and git SHA.
- **Admin → System** (instance admins) shows, on one page:
  - the version, git SHA and uptime;
  - the database and WAL sizes;
  - the last backup;
  - the last run of each background job (backups, reminders, emails, digests, cleanup);
  - whether SMTP is configured, with **Send test email**: a test to your own address that reports whether the mail server accepted it (and its SMTP code if not);
  - the push key status and the number of push subscriptions;
  - the number of live-update (SSE) connections;
  - attachment storage: the backend (local or S3), total size and file count;
  - the number of users, orgs and tasks.
- `/metrics` (Prometheus) is not served in this version; `ROOSTER_METRICS_TOKEN` is reserved for it.

## Security operations

### Rotating the auth secret
Changing `ROOSTER_AUTH_SECRET` and restarting **signs everyone out** (all browser sessions end). Links in emails already sent (invites and unsubscribe links) and sign-ins or consents in progress stop working too. Weak secrets are refused at boot with exit code 78.

### Regenerating the push keys
If the Web Push keys may have leaked, use **Admin → Push keys → Regenerate push keys**. No device is sent anything with the old keys again. Each device where push was on re-subscribes with the new keys the next time the app opens there, by renewing its old subscription; until then it gets no push. A device someone removed never comes back (ADR 0040). Subscriptions still not renewed by the next regeneration are deleted then. Keys set with `ROOSTER_VAPID_*` can't be regenerated from Admin: replace them in the environment instead; that drops nothing on the server, but devices only recover the same way once the app opens.

### Admin access from the command line
CLI logins and personal access tokens never get admin rights by default. An instance admin can give one the `admin` capability (`rooster login --admin`), which is re-checked against `ROOSTER_ADMIN_EMAILS` on every request; OAuth apps and MCP clients can never get it. Review and revoke credentials in **Settings → Security → Connected apps**.

### Agents and discovery
- `ROOSTER_AGENT_DISCOVERY=off` stops advertising the MCP server, the skill and `llms.txt`. The documents reveal only that a rooster instance exists and where its endpoints are, never any data.
- Keep `ROOSTER_OAUTH_DCR` off unless an MCP client you use needs it.
- Keep `ROOSTER_OAUTH_DEVICE` at `first-party` unless an app you use needs the device grant: device-code phishing works by persuading users to type a code an attacker started (ADR 0065). Every approval sends the user a "device connected" notice, by email too when SMTP is set up.

### Search index
The full-text index is rebuilt automatically at boot when it is out of step (for example after a restore). To rebuild it by hand: `rooster admin reindex` (a login with the admin capability), or `POST /api/v1/admin/search/reindex`.

### Privacy
rooster sends no telemetry and makes no outbound calls except to what you configure: your sign-in providers, SMTP, S3, the browsers' push services, and the Client ID Metadata Documents of OAuth clients that connect (fetched through an SSRF guard). Fonts are self-hosted.

## Attachment storage quota

Each user may store up to `ROOSTER_USER_STORAGE_MB` (default 1024 MB) of attachments; `0` turns the quota off.

- It counts the bytes of every attachment the user uploaded that still exists, **including attachments on tasks in Trash** until the Trash is emptied (automatically after 30 days, or by deleting permanently). Thumbnails and avatars don't count.
- An upload that would go past the quota is refused with `413 storage_quota_exceeded` (the problem includes `limitBytes` and `usedBytes`), and nothing is stored.
- Users see their usage in **Settings → Data**. To free space they delete attachments or empty the Trash; you can raise the quota and restart.
- The per-file limit (`ROOSTER_UPLOAD_MAX_MB`) and a limit of 100 attachments per task apply as well.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The container exits with code 78 | Invalid configuration. The log lists every problem: a missing required variable, no sign-in provider, invalid JSON in `ROOSTER_OIDC_PROVIDERS`, a weak `ROOSTER_AUTH_SECRET`, `ROOSTER_SMTP_URL` without `ROOSTER_MAIL_FROM`, or only one of a key pair. |
| The container exits at start with "database startup failed" | The volume isn't writable by UID 65532, or it is on NFS/SMB. Use a local volume owned by the container user. |
| `redirect_uri_mismatch` at the provider | The registered URI differs from `${ROOSTER_BASE_URL}/api/auth/callback/<id>`, often `http` vs `https`, a port, or a trailing slash. |
| Sign-in loops back to the login page | Cookies are rejected. Serve rooster over https, set `ROOSTER_BASE_URL` to the exact public URL, set `ROOSTER_TRUST_PROXY=true`, and make the proxy send `X-Forwarded-Proto: https`. |
| "You're not on the list" | The address isn't allowed: add it to `ROOSTER_ALLOWED_EMAILS`, the allowlist in Admin, or invite the person. |
| Changes from other devices only appear after a reload | The proxy buffers `/api/v1/events`. Turn buffering and compression off for it and allow long timeouts ([Reverse proxy](#reverse-proxy)). |
| Uploads fail with "413 Request Entity Too Large" from the proxy | The proxy's body limit is below the upload limit. Allow at least 30 MB (`client_max_body_size`, `LimitRequestBody`). A 413 from rooster itself names the limit or the storage quota. |
| Push notifications don't arrive | Push needs https. On iPhone and iPad, the app must be added to the Home Screen first. Check that push is on for that device in Settings → Notifications and use its test button. After regenerating the push keys, a device gets push again once the app has been opened on it. |
| No emails | Check `ROOSTER_SMTP_URL` and `ROOSTER_MAIL_FROM`, and the log for SMTP errors. Admin → System shows whether SMTP is configured. Each user chooses which emails they get in Settings → Notifications. |
| A calendar app can't load the feed (404) | The proxy doesn't forward `/ical/` to rooster, or the link was replaced or revoked in Settings → Calendar feed. Calendar apps refresh on their own schedule (often hours). |
| An MCP client can't connect or can't sign in | The proxy must forward `/mcp`, `/.well-known/*` (OAuth metadata at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server/api/auth`) and `/api/auth/*`, and must not buffer `/mcp`. Older clients without Client ID Metadata Document support need `ROOSTER_OAUTH_DCR=on`. |
| "database is locked" errors, or a corrupt database | The volume is a network filesystem, or a second process (another container, a backup tool) writes to `rooster.db`. Use a local filesystem, run one rooster per volume, and back up the snapshots in `backups/`, not the live file. |
| Search misses tasks after a restore | The index is rebuilt at boot when it is out of step; to force it, run `rooster admin reindex`. |
