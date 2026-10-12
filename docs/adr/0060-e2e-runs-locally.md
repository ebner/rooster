# ADR 0060: The e2e suite runs locally, not in CI

- Status: accepted
- Date: 2026-10-12
- Amends: ADR 0052 §4 (where the automated accessibility checks run), 10 §7 (the CI pipeline)

## Context
`pnpm release` runs the whole pipeline on the commit it releases, the image and the backup drill included, with no e2e retries except one for the timing budgets. GitHub Actions then ran the same e2e suite again, in three shards plus a job for the timing budgets, before the tag could be pushed. On shared CI runners that second run failed on load and slowness rather than on bugs: the 1.6.0 run missed AC-2.12's 50 ms budget by 0.3 and 0.9 ms with nothing on that path changed, and the kitchen sink took longer to render than one assertion allowed. Each such failure held up a release by another CI round.

## Decisions
1. **CI runs `static`, `unit` and `build`, then the image** (build, smoke test, backup drill). It no longer runs the Playwright suite or its timing budgets.
2. **The e2e suite is the local release run's job.** `pnpm release` keeps running it in full, on the released commit, with the timing budgets. `pnpm run ci e2e` and `pnpm run ci e2e-perf` (and `ROOSTER_E2E_SHARD`) stay for local use.
3. **A release still waits for CI** before its tag is pushed. That run is now short, and it still checks what the local run can't: a fresh checkout and a clean install from the lockfile.
4. **The automated accessibility checks** (axe on every screen, the keyboard journey, the accessible names) are part of the e2e suite, so they run in the release run too, not in CI.

## Consequences
- A push to main that isn't a release gets no e2e run unless someone runs it locally. Pushes happen only on the maintainer's say-so, nearly always as releases, so this costs little.
- A test that depends on the local machine (its speed, its files) would pass the release run and nothing else would catch it. The release run starts from the committed tree, and the timing budgets get one retry, which limits that.
