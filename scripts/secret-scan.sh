#!/usr/bin/env bash
# Secret scan (10 §6) with gitleaks over the git history. Reviewed test fixtures and examples are
# pinned by fingerprint in .gitleaksignore, so anything new still fails.
set -euo pipefail
cd "$(dirname "$0")/.."

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
