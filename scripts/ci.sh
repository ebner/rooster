#!/usr/bin/env bash
# Vendor-neutral CI pipeline (docs/spec/10-quality.md §7).
# Usage: scripts/ci.sh [static] [unit] [build] [e2e] [--with-docker]
# With no stage, every stage runs in order. CI runs each stage as its own parallel job, so one
# run reports every failing stage; the stages share nothing but the install.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }

stage_static() {
  step "lint";         pnpm lint
  step "typecheck";    pnpm typecheck
  step "dependency audit"; pnpm audit --prod --audit-level high   # 10 §6: high or critical fails
  step "secret scan";  bash scripts/secret-scan.sh   # needs the full git history
  step "i18n";         pnpm i18n:check
  step "docs";         pnpm docs:keyboard --check   # the keyboard page matches keymap.ts (ADR 0053)
  step "api client";   pnpm gen:api && git diff --exit-code -- apps/server/openapi.json packages/api-client/src/schema.d.ts
}

stage_unit() {
  step "unit+coverage"; pnpm test:coverage  # full run: coverage globs are repo-relative
  step "server perf";  pnpm --filter @rooster/server test:perf   # AC-11.4 budgets, alone (no coverage, no parallel files)
}

stage_build() {
  step "build";        pnpm build
  step "bundle budget"; pnpm bundle:check
  step "cli smoke";    pnpm --filter @rooster/cli smoke   # own in-memory server; no e2e ports
}

stage_e2e() {
  step "e2e";          pnpm e2e   # builds the web app itself for the PWA projects
}

stage_docker() {
  step "docker build"; docker build -f docker/Dockerfile -t rooster:ci .
  step "docker smoke"; bash scripts/docker-smoke.sh rooster:ci
  step "backup drill"; bash scripts/backup-drill.sh rooster:ci   # 10 §3.6: backup, restore, verify (uploads included)
}

stages=()
docker=false
for arg in "$@"; do
  case "$arg" in
    static | unit | build | e2e) stages+=("$arg") ;;
    --with-docker) docker=true ;;
    *) echo "ci.sh: unknown argument '$arg' (stages: static unit build e2e; --with-docker)" >&2; exit 2 ;;
  esac
done
((${#stages[@]})) || stages=(static unit build e2e)

step "install";      pnpm install --frozen-lockfile
for stage in "${stages[@]}"; do "stage_$stage"; done
if $docker; then stage_docker; fi
