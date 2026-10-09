#!/usr/bin/env bash
# Single-file `rooster` binaries with `bun build --compile` (07 §1, WP 8.4). Bun is only the
# build tool here; the npm package and the server run on Node.
#
#   apps/cli/scripts/build-binaries.sh                 # every target
#   apps/cli/scripts/build-binaries.sh linux-x64 ...   # some of them
#
# Output: apps/cli/dist/bin/rooster-<version>-<target>[.exe] plus a .sha256 file each.
# The keychain addon stays external: a binary stores credentials in the 0600 credentials
# file and says so once (src/secrets.ts), which works the same on every target.
set -euo pipefail

cd "$(dirname "$0")/.."

ALL_TARGETS=(linux-x64 linux-arm64 darwin-arm64 darwin-x64 windows-x64)
if [[ $# -gt 0 ]]; then TARGETS=("$@"); else TARGETS=("${ALL_TARGETS[@]}"); fi

if ! command -v bun >/dev/null 2>&1; then
  echo "build-binaries: bun is required (https://bun.sh)" >&2
  exit 1
fi

# The binaries wrap the same bundle as the npm package.
if [[ ! -f dist/rooster.mjs ]]; then
  pnpm build
fi

VERSION="$(node -p "require('./package.json').version")"
mkdir -p dist/bin

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi
}

for target in "${TARGETS[@]}"; do
  case "$target" in
    linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64 | windows-x64) ;;
    *)
      echo "build-binaries: unknown target '$target' (use: ${ALL_TARGETS[*]})" >&2
      exit 2
      ;;
  esac
  ext=""
  if [[ "$target" == windows-* ]]; then ext=".exe"; fi
  name="rooster-${VERSION}-${target}${ext}"
  echo "build-binaries: $name"
  bun build dist/rooster.mjs \
    --compile \
    --minify \
    --target="bun-${target}" \
    --external @napi-rs/keyring \
    --outfile "dist/bin/${name}"
  (cd dist/bin && checksum "$name" > "${name}.sha256")
done

ls -l dist/bin
