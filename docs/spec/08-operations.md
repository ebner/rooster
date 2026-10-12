# 08: Operations

Goal: **one container, one volume, one env file.** Nothing has to be run by hand after `docker compose up -d`. Upgrades are `docker compose pull && docker compose up -d`.

## 1. Image

- **Multi-stage build** (`docker/Dockerfile`):
  1. `node:24-bookworm-slim` as `deps`: `corepack enable`, then `pnpm fetch` using the lockfile.
  2. `build`: `pnpm install --offline --frozen-lockfile`, then `pnpm -r build` (web via Vite, server via tsdown), then `pnpm deploy --filter @rooster/server --prod /out`. better-sqlite3 and sharp are compiled or fetched for linux and glibc here.
  3. `runtime`: `gcr.io/distroless/nodejs24-debian12:nonroot` (UID 65532). The stage copies `/out` and the web build (`/out/public`).
- `ENV NODE_ENV=production ROOSTER_DATA_DIR=/data PORT=3000`
- `VOLUME /data`, `EXPOSE 3000`
- `HEALTHCHECK CMD ["/nodejs/bin/node", "dist/healthcheck.js"]`, which calls `GET /readyz` with a 3 s timeout.
- **Entrypoint:** `node dist/main.js`. Graceful shutdown on SIGTERM:
  1. Stop accepting connections.
  2. Close the SSE streams.
  3. Wait for in-flight requests (≤ 10 s).
  4. Stop the scheduler.
  5. Close the DB.
- linux/amd64 (ADR 0052 §9; arm64 is not built). Published to `ghcr.io/201works/rooster` as `x.y.z`, `x.y`, `x` and `latest`.
- Target size: under 350 MB uncompressed in total, of which rooster's own layers (bundled server, web build, native modules: SQLite and, from P10, sharp with libvips) are under 100 MB (ADR 0048). The distroless Node 24 base accounts for about 200 MB. RAM use is about 100 to 150 MB.

## 2. `/data` layout

```
/data/
  rooster.db  rooster.db-wal  rooster.db-shm
  attachments/<orgId>/<attachmentId>[.thumb.webp]   # if local storage
  backups/rooster-2026-10-04T03-00.db               # rotated
```

The volume **must be a local filesystem**. NFS and SMB break SQLite WAL locking.

On boot, the server:
1. Validates the config.
2. Ensures the directories exist.
3. Makes an **automatic pre-update backup** (`backups/pre-migrate-<ts>.db`) of an existing database if migrations are pending or the server version differs from the one that last booted it (`last_boot_version` in `instance_setting`, written after a successful migration; a database without it counts as changed). Upgrades and downgrades are both covered; a fresh database is not backed up. These copies are rotated like manual backups (the newest 10 are kept).
4. Applies the migrations.
5. Generates VAPID keys and the instance ID on first boot (stored in `instance_setting`).
6. Starts listening.

## 3. Configuration (env)

| Variable | Required | Default | Description |
|---|---|---|---|
| `ROOSTER_BASE_URL` | ✅ | — | Public URL, e.g. `https://rooster.example.com`. Used for OIDC callbacks, cookies, links and the CSRF origin check. |
| `ROOSTER_AUTH_SECRET` | ✅ | — | ≥ 32 random bytes (base64). Generate with `openssl rand -base64 48`. |
| `ROOSTER_ADMIN_EMAILS` | ✅ | — | Comma-separated. These users are always allowed to sign in and are instance admins. |
| `ROOSTER_ALLOWED_EMAILS` | | — | Comma-separated extra allowed emails (in addition to the admin UI allowlist). |
| `ROOSTER_ALLOWED_DOMAINS` | | — | e.g. `northwind.example`. |
| `ROOSTER_GOOGLE_CLIENT_ID` / `_SECRET` | one provider required | — | Google OAuth client. |
| `ROOSTER_OIDC_PROVIDERS` | | `[]` | JSON array: `[{"id":"authentik","name":"Company SSO","discoveryUrl":"https://sso.example.com/application/o/rooster/.well-known/openid-configuration","clientId":"…","clientSecret":"…","scopes":["openid","email","profile"],"trustEmail":false}]`. `trustEmail` (default false) allows linking to an existing account by verified email; see `docs/oidc-setup.md`. |
| `ROOSTER_DATA_DIR` | | `/data` | |
| `PORT` | | `3000` | |
| `ROOSTER_TRUST_PROXY` | | `false` | Honour `X-Forwarded-For` and `X-Forwarded-Proto`. Set this behind a reverse proxy. |
| `ROOSTER_TRUSTED_PROXY_HOPS` | | `1` | With `ROOSTER_TRUST_PROXY`: the client IP is this many entries from the right of `X-Forwarded-For` (one per trusted proxy). |
| `ROOSTER_LOG_LEVEL` | | `info` | |
| `ROOSTER_SMTP_URL` | | — | `smtp://` or `smtps://`, e.g. `smtps://user:pass@smtp.example.com:465`. Enables email features (invites by email, notification emails, the digest). |
| `ROOSTER_MAIL_FROM` | with SMTP | — | `Rooster <rooster@example.com>` or a bare address. Missing while SMTP is set: exit 78. |
| `ROOSTER_VAPID_PUBLIC` / `_PRIVATE` / `ROOSTER_VAPID_SUBJECT` | | auto-generated / `mailto:<first admin>` | Web Push. Set both keys or neither (base64url, 65 and 32 bytes); without them the keys are generated once and kept in `instance_setting`. Keys from the env cannot be regenerated in the admin UI. The subject is a `mailto:` or `https:` URL. |
| `ROOSTER_OAUTH_DCR` | | `off` | P9. `on` enables OAuth Dynamic Client Registration for older MCP clients that lack Client ID Metadata Document support (11 §4.2). |
| `ROOSTER_AGENT_DISCOVERY` | | `on` | P9. `off` hides the best-effort agent discovery documents (Server Card, AI Catalog, skills index, `llms.txt`); the OAuth metadata stays (11 §6.1). |
| `ROOSTER_UPLOAD_MAX_MB` | | `25` | |
| `ROOSTER_USER_STORAGE_MB` | | `1024` | Attachment storage per user; `0` = no quota (ADR 0052 §6). |
| `ROOSTER_S3_ENDPOINT`, `_REGION`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_FORCE_PATH_STYLE` | | — | Setting the bucket switches attachments to S3. |
| `ROOSTER_BACKUP_CRON` | | `0 3 * * *` | Set to `off` to disable. |
| `ROOSTER_BACKUP_KEEP_DAILY` / `_WEEKLY` | | `7` / `4` | |
| `TZ` | | `UTC` | Server timezone, used only for logs. User-facing time logic uses user timezones. |

Every variable also accepts a `<NAME>_FILE` form (Docker secrets): when it is set, the value is read from that file.

## 4. `compose.yaml` (shipped example)

```yaml
services:
  rooster:
    image: ghcr.io/201works/rooster:1
    restart: unless-stopped
    env_file: .env
    environment:
      ROOSTER_TRUST_PROXY: "true"
    volumes:
      - rooster-data:/data
    ports:
      - "127.0.0.1:3000:3000"     # or attach to your proxy network instead
volumes:
  rooster-data:
```

An optional overlay, `compose.litestream.yaml`, adds a Litestream 0.5 sidecar that shares the volume and replicates continuously to S3 or another target for point-in-time restore. Follow Litestream's guidance on checkpointing.

## 5. Reverse proxy snippets (`docker/proxy/`)

**SSE must not be buffered**, and its idle timeout must be ≥ 60 s.

**Client IP:** the proxy must not pass on a client-supplied `X-Forwarded-For` chain. rooster takes the right-most `ROOSTER_TRUSTED_PROXY_HOPS` entry (default 1) as the client address for rate limits and the session list (ADR 0017). nginx: `$remote_addr`, not `$proxy_add_x_forwarded_for`. Apache: `RequestHeader unset X-Forwarded-For early`. Caddy ignores the incoming header unless `trusted_proxies` is set.

**Request bodies:** rooster enforces its own limits (64 KB for `/api/auth`, 1 MB for `/api/v1`), so the proxy limit only needs to fit future uploads.

**Caddy**
```
rooster.example.com {
  reverse_proxy rooster:3000
}
```
Caddy streams `text/event-stream` correctly by default.

**nginx**
```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 30m;
}
location /api/v1/events {
  proxy_pass http://127.0.0.1:3000;
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 1h;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
}
```
The server also sends the `X-Accel-Buffering: no` header on the SSE route.

**Apache httpd**: see `docker/proxy/apache.conf` (`flushpackets=on` and `no-gzip` for `/api/v1/events`).

**Traefik**: labels for a router and service on port 3000. No special SSE config is needed. Raise `respondingTimeouts` if they have been customised.

## 6. OIDC setup cheatsheet (README + `/admin` hints)

| Provider | Redirect URI to register |
|---|---|
| Google | `${ROOSTER_BASE_URL}/api/auth/callback/google` (OAuth consent screen: "Internal" for Workspace, or "External" + test users) |
| Generic (`id` = `authentik`) | `${ROOSTER_BASE_URL}/api/auth/callback/authentik` (better-auth 1.7 serves generic OIDC providers on the core callback route) |

Step-by-step instructions for Google, Authentik and Keycloak are in [`docs/oidc-setup.md`](../oidc-setup.md).

The required claims are `email`, `email_verified` and `name`, with `picture` optional. Users whose email is not verified are rejected.

## 7. Backups & restore

- **Built in:** a nightly `VACUUM INTO` writes a consistent snapshot to `/data/backups/`, rotated (7 daily and 4 weekly). Admins can trigger a backup and download one from Admin → Backups. A snapshot plus the `attachments/` directory is a complete backup.
- **Off-site:** sync `/data/backups` and `/data/attachments` with restic, borg or rclone from the host, or use the Litestream overlay.
- **Restore:**
  1. `docker compose stop rooster`.
  2. Copy the chosen snapshot over `/data/rooster.db` and delete `rooster.db-wal` and `rooster.db-shm`.
  3. Start the container. Migrations bring the schema forward if the snapshot is older.
- The restore procedure is tested in CI (10 §3.6).

## 8. Upgrades & versioning

- SemVer, with images tagged `x.y.z`, `x.y` and `x`. Pin the major version (`:1`) in compose.
- Migrations are forward-only and applied automatically. Every version change (with or without migrations) takes a pre-update backup automatically, as described in §2.
- **Downgrading** across a migration requires restoring the pre-update backup. This is documented in `CHANGELOG.md` for every migration.
- After an upgrade, PWAs detect the new version through the SSE `hello` event and the SW update check, then show "New version available".

## 9. Monitoring
- Docker healthcheck plus `/readyz`. There is no Prometheus endpoint (ADR 0052 §9).
- Logs are pino JSON on stdout; use `docker logs`, Loki or similar.
- Admin → System shows the version, the DB and WAL sizes, the last backup, job runs, SMTP and push status, and the SSE connection count. With SMTP it can send a test email to the signed-in admin (ADR 0059).

## 10. Security operations
- Rotating `ROOSTER_AUTH_SECRET` invalidates all sessions. This is documented.
- To rotate VAPID keys, delete them from `instance_setting` (via `/admin/system` → "Regenerate push keys"). Push subscriptions are then dropped, and push is off on every device until each user turns it on again in Settings → Notifications. Devices deliberately do not re-subscribe silently, so a device the user removed can never come back by itself (ADR 0040).
- No telemetry, no external calls except the configured integrations, and no CDN fonts (D-28 self-hosted).
