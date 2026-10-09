# ADR 0039: The rooster CLI (Phase 8)

- Status: accepted
- Date: 2026-10-09
- Amends: 07 §1–§4
- Code: `apps/cli/**`, `.github/workflows/release.yml` (`cli-*` jobs), `scripts/ci.sh` (`cli smoke`)

## Decisions
1. **Login requests every capability**, `tasks:delete` included, because it is the user's own terminal and `rm` is a CLI command. `--scope` requests less, and orgs and groups are chosen on the `/device` page: the device code request carries scopes, not constraints.
2. **PATs default to `tasks:read` for 90 days.**
   - `--org` lists orgs.
   - `--group org/Name` limits reading.
   - `--write-group org/Name` limits writing, and those groups are readable too.
   - A write scope on a listed org without groups writes the whole org.
3. **Refs resolve on the server** (`GET /tasks/resolve`). Only `@last` and `-` (stdin) are expanded locally, and there is no list scanning. Titles go to the server raw, with `parse: true`, so the CLI, MCP and the server parse alike.
4. **`add` and `mv` put tasks at the top** of their group, as 07 says. When the server chose the group from a `>Group` token, the CLI follows with one move to the top.
5. **Errors map to the exit codes of 07 §4.2.**
   - `forbidden_scope` and `outside_grant` exit 3 and print the server's explanation, which names the allowed groups. Swedish builds it from the grant.
   - `ambiguous_ref` exits 4 and lists the candidates.
   - 429 and 5xx exit 6.
   - With `--json`, errors are JSON on stderr.
6. **Colours come from the Coop tokens:**
   - truecolor where the terminal says so, else 256 colours, else basic ANSI picked by hue;
   - overdue is also marked with `!`;
   - colour is off for `NO_COLOR`, `--no-color`, `--json`, `TERM=dumb` and pipes; `FORCE_COLOR` overrides.
7. **Secrets: one store per profile, chosen at login** (amended after the security review, ADR 0040).
   - Login writes the OS keychain (`@napi-rs/keyring`, loaded lazily, optional) and reads it back. If the keychain is positively absent (a strict allowlist: no addon, no Secret Service or D-Bus session, no session keyring, unsupported platform), login uses a 0600 file under `credentials.d/<profile>` instead, with a one-time notice. A keychain that refuses (locked, denied, unreachable) fails the login with the `ROOSTER_KEYRING=off` hint.
   - The profile records `credential_store` and the server origin. Reads use only that store and never fall back.
   - Logout succeeds only when the delete is confirmed.
   - The compiled binaries always use the file, which keeps cross-compilation deterministic.
8. **Opening things is argv-only.** The browser opens only https URLs (http only for loopback) on the profile's server origin, through `xdg-open`, `open` or `rundll32 url.dll,FileProtocolHandler`, never a shell; anything else is printed. `$VISUAL`/`$EDITOR` is split into argv and run without a shell. User content is stripped of control and bidi characters before printing.
9. **`logout`** revokes the current grant when it is a device login. A PAT is only forgotten locally, since CI may use it elsewhere; the CLI points to `rooster token revoke`.
10. **Distribution.**
    - `dist/rooster.mjs` bundles everything except the optional keychain addon, so it has no runtime dependencies besides it.
    - Single-file binaries for Linux x64/arm64, macOS arm64/x64 and Windows x64 are built with Bun in the release workflow, smoke-tested on each OS, and attached to the GitHub release.
