#!/usr/bin/env bash
# pnpm docs:screenshots (ADR 0052 §3): seeds the fictional Kestrel Lane team into a fresh server
# and captures the guide's and README's screenshots into docs/screenshots/.
#
#   pnpm docs:screenshots                         # everything
#   DOCS_SHOTS=my-tasks,inbox pnpm docs:screenshots   # only these shots (others are kept)
#   pnpm docs:screenshots --project=desktop-light     # extra arguments go to Playwright
#
# It uses the e2e ports (9400, 3181, 5181), so it waits for the shared e2e lock.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
data_dir="$(mktemp -d "${TMPDIR:-/tmp}/rooster-docs-XXXXXX")"
trap 'rm -rf "$data_dir"' EXIT
export ROOSTER_DOCS_DATA_DIR="$data_dir"

start=$(date +%s)
echo "docs:screenshots: data in $data_dir (removed afterwards)"
status=0
flock /tmp/rooster-e2e.lock \
  pnpm --dir "$root/apps/web" exec playwright test \
  --config "$root/scripts/docs/screenshots.config.ts" "$@" || status=$?

# Optimise whatever was captured, even after a partial failure: the failed shots keep their
# previous image in docs/screenshots.
if [ -d "$data_dir/raw" ]; then
  node "$root/scripts/docs/optimize-screenshots.mjs" "$data_dir/raw" "$root/docs/screenshots"
fi
echo "docs:screenshots: $(( $(date +%s) - start )) s"
exit "$status"
