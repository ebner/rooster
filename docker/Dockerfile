# syntax=docker/dockerfile:1.7
# rooster: single-container image (see docs/spec/08-operations.md §1)

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# ---- dependencies (cached on lockfile + manifests) ----
FROM base AS deps
# Toolchain for native modules (better-sqlite3) when no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/i18n/package.json packages/i18n/
COPY packages/tokens/package.json packages/tokens/
COPY packages/api-client/package.json packages/api-client/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY . .
RUN pnpm --filter @rooster/web build \
 && pnpm --filter @rooster/server build
# Runtime folder: the bundled server (all JS deps inlined by tsdown), the web build, and a
# node_modules containing only the native modules that cannot be bundled (better-sqlite3).
RUN mkdir -p /out /out-data \
 && cp -r apps/server/dist /out/dist \
 && cp -r apps/web/dist /out/public \
 && SQLITE_VERSION="$(node -p "require('./apps/server/node_modules/better-sqlite3/package.json').version")" \
 && printf '{"name":"rooster-server","private":true,"type":"module","dependencies":{"better-sqlite3":"%s"}}\n' "$SQLITE_VERSION" > /out/package.json \
 && cd /out && npm install --omit=dev --no-audit --no-fund --no-package-lock \
 && rm -rf /out/node_modules/better-sqlite3/deps /out/node_modules/better-sqlite3/src

# ---- runtime ----
FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime
ARG ROOSTER_VERSION=0.0.0
ARG ROOSTER_GIT_SHA=dev
LABEL org.opencontainers.image.title="rooster" \
      org.opencontainers.image.source="https://github.com/201works/rooster" \
      org.opencontainers.image.version="${ROOSTER_VERSION}" \
      org.opencontainers.image.revision="${ROOSTER_GIT_SHA}"
ENV NODE_ENV=production \
    ROOSTER_DATA_DIR=/data \
    ROOSTER_GIT_SHA=${ROOSTER_GIT_SHA} \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out /app
# Pre-create /data owned by the nonroot user (UID 65532) so a fresh named volume inherits it
# (distroless has no shell, so we copy an empty directory instead of running mkdir).
COPY --from=build --chown=nonroot:nonroot /out-data /data
USER nonroot
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/dist/healthcheck.js"]
CMD ["/app/dist/main.js"]
