# ADR 0048: Docker image budget raised for Phase 10

- Status: accepted
- Date: 2026-10-09
- Amends: 08 §2 (image size target), `scripts/docker-smoke.sh`

## Context
The image budget was under 250 MB in total and under 50 MB for rooster's own layers. Phase 7 (nodemailer, web-push, react-dom/server) and Phase 9 (the OAuth provider, the MCP SDK) brought 1.3.0 to 248 MB. Phase 10 attachments need `sharp` with libvips for thumbnails (10.2), a native dependency of roughly 30–40 MB. It was decided to raise the budget instead of blocking Phase 10 on slimming the base image.

## Decision
- The total image must stay under **350 MB**, and rooster's own layers under **100 MB**. Both are checked by the Docker smoke test in CI and in the release workflow.
- The distroless Node 24 base stays. Slimming the base image remains a Phase 11 item.

## Consequences
- There is room for `sharp` and normal growth through v2.0. A new native dependency still goes in `NATIVE_DEPS` and the Dockerfile (AGENTS.md).
