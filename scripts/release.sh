#!/usr/bin/env bash
# Prepares a release locally and proves it before anything reaches origin.
# Usage: scripts/release.sh X.Y.Z [--check]
#
# Before you run it, write the release notes: the CHANGELOG's [Unreleased] section, the
# "## Unreleased" section of docs/guide/{en,sv}/whats-new.md (what users notice; ADR 0057) and
# the AGENTS.md "Latest release" line (starting with the new version). Those files may be
# uncommitted; everything else must be committed.
#
#   1. Preflight (seconds): main, up to date with origin, the tag is free, the notes are written,
#      the migration fixture is from the latest release that changed the schema, Docker is up.
#   2. Bump every package.json, the Dockerfile's ROOSTER_VERSION, the CHANGELOG heading (with
#      the release's migrations) and the What's new headings, then regenerate the API document.
#   3. The whole pipeline with the image (scripts/ci.sh --with-docker) and without e2e retries,
#      so a flaky test fails here rather than in CI. It holds the e2e lock.
#   4. Commit `chore(release): X.Y.Z` and tag vX.Y.Z, both locally. Nothing is pushed.
#
# --check runs only the preflight. On any failure the bump is undone, so fix, commit, re-run.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

fail() { printf '\033[1;31mrelease: %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }

version="${1:-}"
check_only=false
[[ "${2:-}" == "--check" ]] && check_only=true
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "usage: scripts/release.sh X.Y.Z [--check]"

current="$(node -p 'require("./package.json").version')"
newer="$(node -e '
  const [a, b] = process.argv.slice(1).map((v) => v.split(".").map(Number));
  const d = a.map((x, i) => x - b[i]).find((x) => x !== 0) ?? 0;
  console.log(d > 0);' "$version" "$current")"

step "preflight: $current → $version"
[[ "$newer" == true ]] || fail "$version is not newer than $current"
[[ "$(git branch --show-current)" == main ]] || fail "not on main"
git fetch --quiet origin main --tags
git merge-base --is-ancestor origin/main HEAD || fail "behind origin/main: pull first"
git rev-parse -q --verify "refs/tags/v$version" >/dev/null && fail "tag v$version exists"
whats_new=(docs/guide/en/whats-new.md docs/guide/sv/whats-new.md)
dirty="$(git status --porcelain | grep -vE '^.. (CHANGELOG\.md|AGENTS\.md|docs/guide/(en|sv)/whats-new\.md)$' || true)"
[[ -z "$dirty" ]] || fail "uncommitted changes besides the release notes:
$dirty"

unreleased="$(awk '/^## \[Unreleased\]/{on=1; next} /^## \[/{on=0} on' CHANGELOG.md | grep -c '^- ' || true)"
((unreleased > 0)) || fail "CHANGELOG.md: [Unreleased] has no entries"
for page in "${whats_new[@]}"; do
  notes="$(awk '/^## Unreleased$/{on=1; next} /^## /{on=0} on' "$page" | grep -c '^- ' || true)"
  ((notes > 0)) || fail "$page: write what users notice under \"## Unreleased\" (one line per change, or that nothing visible changed)"
done
grep -q "^- \*\*Latest release:\*\* $version " AGENTS.md ||
  fail "AGENTS.md: start the \"Latest release\" line with $version and what it brings"

previous="v$current"
git rev-parse -q --verify "refs/tags/$previous" >/dev/null || fail "no tag $previous for the current version"
migrations=apps/server/src/db/migrations
fixture="$(sed -nE "s/.*'(release-[0-9.]+)\.sql'.*/\1/p" apps/server/test/migration-fixture.test.ts)"
fixture_tag="v${fixture#release-}"
git rev-parse -q --verify "refs/tags/$fixture_tag" >/dev/null || fail "migration fixture $fixture has no tag"
git diff --quiet "$fixture_tag" "$previous" -- "$migrations" ||
  fail "the migration fixture is $fixture, but $previous changed the schema since: refresh it
  from $previous (apps/server/test/fixtures/make-release-fixture.ts says how)"
new_migrations="$(git diff --name-only --diff-filter=A "$previous" HEAD -- "$migrations/*.sql" | xargs -r -n1 basename)"
if [[ -n "$new_migrations" ]]; then
  awk '/^## \[Unreleased\]/{on=1; next} /^## \[/{on=0} on' CHANGELOG.md | grep -q '^### Migrations' ||
    fail "CHANGELOG.md: [Unreleased] needs a ### Migrations section for: $(tr "\n" " " <<<"$new_migrations")"
fi

docker info >/dev/null 2>&1 || fail "Docker is not running (the image build, smoke test and backup drill need it)"
echo "ok: notes written, fixture $fixture current, $(echo "$new_migrations" | grep -c . || true) new migration(s)"
$check_only && exit 0

# From here on, a failure puts every file back the way it was.
backup="$(mktemp -d)"
cp CHANGELOG.md AGENTS.md "$backup/"
cp "${whats_new[0]}" "$backup/whats-new.en.md"
cp "${whats_new[1]}" "$backup/whats-new.sv.md"
restore() {
  git checkout --quiet -- . 2>/dev/null || true
  cp "$backup/CHANGELOG.md" "$backup/AGENTS.md" .
  cp "$backup/whats-new.en.md" "${whats_new[0]}"
  cp "$backup/whats-new.sv.md" "${whats_new[1]}"
  printf '\033[1;31mrelease: failed; the bump is undone. Fix, commit, run again.\033[0m\n' >&2
  exit 1
}
trap restore ERR INT TERM

step "bump to $version"
node -e '
  const fs = require("node:fs");
  const version = process.argv[1];
  for (const file of process.argv.slice(2)) {
    const text = fs.readFileSync(file, "utf8");
    const next = text.replace(/^(  "version": )"[^"]+"/m, `$1"${version}"`);
    if (next === text) throw new Error(`${file}: no version field`);
    fs.writeFileSync(file, next);
  }' "$version" package.json apps/*/package.json packages/*/package.json
sed -i -E "s/^ARG ROOSTER_VERSION=.*/ARG ROOSTER_VERSION=$version/" docker/Dockerfile
node -e '
  const fs = require("node:fs");
  const [version, date] = process.argv.slice(1);
  let text = fs.readFileSync("CHANGELOG.md", "utf8");
  const start = text.indexOf("## [Unreleased]\n");
  const end = text.indexOf("\n## [", start + 1);
  let section = text.slice(start + "## [Unreleased]\n".length, end).trimEnd();
  if (!/^### Migrations/m.test(section)) {
    section += "\n\n### Migrations\n- None.";
  }
  text = `${text.slice(0, start)}## [Unreleased]\n\n## [${version}] - ${date}\n${section}\n${text.slice(end)}`;
  fs.writeFileSync("CHANGELOG.md", text);' "$version" "$(date +%F)"
sed -i -E "s/^## Unreleased$/## $version\n\n_$(date +%F)_/" "${whats_new[@]}"
pnpm gen:api >/dev/null

step "the whole pipeline, with the image, no e2e retries (waits for the e2e lock)"
flock /tmp/rooster-e2e.lock bash scripts/ci.sh --with-docker

step "commit and tag"
git add -u   # tracked files only: build output never lands in the release
git commit --quiet -m "chore(release): $version"
git tag -a "v$version" -m "rooster $version"
trap - ERR INT TERM
rm -rf "$backup"
cat <<EOF

Release $version is committed and tagged locally ($(git rev-parse --short HEAD)). To publish:
  git push origin main          # wait for CI to pass, then
  git push origin v$version     # release.yml builds and publishes the image
EOF
