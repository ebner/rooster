#!/usr/bin/env bash
# Vendor-neutral CI pipeline (docs/spec/10-quality.md §7). Usage: scripts/ci.sh [--with-docker]
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }

step "install";      pnpm install --frozen-lockfile
step "lint";         pnpm lint
step "typecheck";    pnpm typecheck
step "dependency audit"; pnpm audit --prod --audit-level high   # 10 §6: high or critical fails
step "secret scan";  bash scripts/secret-scan.sh
step "i18n";         pnpm i18n:check
step "docs";         pnpm docs:keyboard --check   # the keyboard page matches keymap.ts (ADR 0053)
step "unit+coverage"; pnpm test:coverage  # full run: coverage globs are repo-relative
step "api client";   pnpm gen:api && git diff --exit-code -- apps/server/openapi.json packages/api-client/src/schema.d.ts
step "build";        pnpm build
step "bundle budget"; pnpm bundle:check
step "cli smoke";    pnpm --filter @rooster/cli smoke   # own in-memory server; no e2e ports
step "e2e";          pnpm e2e

if [[ "${1:-}" == "--with-docker" ]]; then
  step "docker build"; docker build -f docker/Dockerfile -t rooster:ci .
  step "docker smoke"; bash scripts/docker-smoke.sh rooster:ci
fi
