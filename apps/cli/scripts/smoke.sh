#!/usr/bin/env bash
# Smoke test for a built CLI (07 §1, WP 8.4): `--version`, `login --with-token` and `whoami`
# against a real server, in a throwaway home so no real config or keychain is touched.
#
#   apps/cli/scripts/smoke.sh node apps/cli/dist/rooster.mjs
#   apps/cli/scripts/smoke.sh apps/cli/dist/bin/rooster-1.2.0-linux-x64
#
# Without ROOSTER_SMOKE_SERVER and ROOSTER_SMOKE_TOKEN it starts an in-process server with a
# fresh user and token (scripts/smoke-server.ts; needs the repo's dev dependencies).
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: smoke.sh <rooster command…>" >&2
  exit 2
fi
ROOSTER=("$@")
CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"

WORK="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

if [[ -z "${ROOSTER_SMOKE_SERVER:-}" || -z "${ROOSTER_SMOKE_TOKEN:-}" ]]; then
  # One plain node process (no pnpm or tsx wrapper), so the trap's kill really stops it.
  (cd "$CLI_DIR" && exec node --import tsx scripts/smoke-server.ts "$WORK/server.env") \
    >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 120); do
    [[ -s "$WORK/server.env" ]] && break
    sleep 0.5
  done
  if [[ ! -s "$WORK/server.env" ]]; then
    echo "smoke: the server did not start" >&2
    exit 1
  fi
  # shellcheck disable=SC1091
  source "$WORK/server.env"
fi

export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/config" XDG_STATE_HOME="$WORK/state" \
  XDG_CACHE_HOME="$WORK/cache" APPDATA="$WORK/appdata" LOCALAPPDATA="$WORK/localappdata" \
  NO_COLOR=1 ROOSTER_KEYRING="${ROOSTER_KEYRING:-off}"
unset ROOSTER_TOKEN ROOSTER_SERVER ROOSTER_PROFILE ROOSTER_ORG
mkdir -p "$HOME"

echo "smoke: --version"
"${ROOSTER[@]}" --version

echo "smoke: login --with-token"
printf '%s' "$ROOSTER_SMOKE_TOKEN" | "${ROOSTER[@]}" login --with-token --server "$ROOSTER_SMOKE_SERVER"

echo "smoke: whoami"
WHO="$("${ROOSTER[@]}" whoami)"
echo "$WHO"
if ! grep -q "${ROOSTER_SMOKE_EMAIL:-smoke@example.com}" <<<"$WHO"; then
  echo "smoke: whoami did not print the user" >&2
  exit 1
fi

echo "smoke: --version (with the server's)"
"${ROOSTER[@]}" --version | grep -q "server" || {
  echo "smoke: --version did not report the server" >&2
  exit 1
}
echo "smoke: logout"
"${ROOSTER[@]}" logout
if "${ROOSTER[@]}" whoami >/dev/null 2>&1; then
  echo "smoke: still signed in after logout" >&2
  exit 1
fi
echo "smoke: ok"
