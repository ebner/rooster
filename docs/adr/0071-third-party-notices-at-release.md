# ADR 0071: Third-party notices are a release gate, not a PR gate

- Status: accepted
- Date: 2026-11-17
- Amends: AGENTS.md ("Run `pnpm notices` after any dependency change"); the static stage of `scripts/ci.sh`
- Code: `scripts/third-party-notices.mjs` (`--check` exit codes), `scripts/ci.sh` (`notices_check`), `scripts/release.sh`, `.github/workflows/release.yml` (`notices` job)

## Context
`THIRD-PARTY-NOTICES.txt` is generated from the installed dependencies and committed, and CI's static stage failed whenever it differed from them. Every dependency change therefore had to regenerate it in the same commit. Dependabot's npm pull requests (security updates) only bump the catalog and the lockfile, so each of them failed CI and couldn't be merged; #3 and #4 (hono, @hono/node-server, 2026-11) had to be redone by hand. The file only matters where it ships: the image, the CLI binaries and the GitHub release, which are all built from a release tag.

## Decisions
1. **`--check` tells the two failures apart:** exit 2 when the file is only out of date, exit 1 when the notices can't be produced (a licence to resolve by hand, a stale native manifest, a missing package).
2. **CI warns on exit 2** (a GitHub annotation on the run) and still fails on exit 1. A dependency PR passes; one that brings a licence the generator can't resolve still fails, because that needs a person anyway.
3. **`pnpm release` regenerates the file** after the version bump, so the release commit and its tag always carry a current copy.
4. **`release.yml` checks the tag strictly** (`notices` job, push only) before the image is pushed; the CLI release waits for the image. A tag cut without `pnpm release` and a stale file can't publish. A manual rebuild of an older tag skips it, like the image.
5. Between releases the committed file may lag main's dependencies. Nothing is distributed from main, so that is accepted; `pnpm notices` still brings it up to date at any time.

## Considered
- **A workflow that commits the regenerated file to Dependabot's branches.** It needs a write token on PR runs that install the new dependency, a token other than `GITHUB_TOKEN` to trigger CI again, and Dependabot stops rebasing a branch someone else pushed to.
- **Not committing the file, generating it in the image and release builds only.** Cleanest, but the README, the site and the release assets link the committed copy, and the Docker build installs only the server and web packages, not the CLI's.
