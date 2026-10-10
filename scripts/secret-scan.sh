#!/usr/bin/env bash
# Secret scan (10 §6) with gitleaks over the git history. Reviewed test fixtures and examples are
# pinned by fingerprint in .gitleaksignore, so anything new still fails.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(git rev-parse --is-shallow-repository)" == true ]]; then
  # A shallow clone squashes the history into one commit, so no .gitleaksignore fingerprint matches.
  echo "secret-scan: shallow clone; fetch the full history (git fetch --unshallow, or fetch-depth: 0)" >&2
  exit 1
fi

version=v8.28.0
args=(git --redact --no-banner)
if command -v gitleaks > /dev/null; then
  gitleaks "${args[@]}" .
elif command -v docker > /dev/null; then
  docker run --rm -v "$PWD:/repo" "ghcr.io/gitleaks/gitleaks:${version}" "${args[@]}" /repo
else
  echo "secret-scan: neither gitleaks nor docker is available" >&2
  exit 1
fi
