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
7. **Secrets: one store per profile, chosen at login, addressed by exact refs** (amended after the security reviews, ADR 0040).
   - Login stages the token under a fresh ref and never touches the active one: an OS keychain account `<profile>:<uuidv7>` (`@napi-rs/keyring`, loaded lazily, optional), verified by a read-back; or, only when the keychain is positively absent (a strict allowlist: no addon, no Secret Service or D-Bus session, no session keyring, unsupported platform) or `ROOSTER_KEYRING=off`, a new 0600 file `credentials.d/<first 32 hex of sha256(profile)>-<uuidv7>` (bounded and case-safe), with a one-time notice. A keychain that refuses fails the login (exit 3, with the `ROOSTER_KEYRING=off` hint).
   - The profile records `credential_store`, `credential_ref` and `credential_origin`, published in one locked swap of `config.toml`. If the swap fails, the staged ref is deleted (with a warning when that can't be confirmed) and the error is raised. After the swap, exactly the previous ref is deleted, and a failure there is only a warning. Cleanup never touches any other ref.
   - Every read-modify-write of `config.toml` holds `config.toml.lock`, created exclusively with the pid and time, with a bounded wait (only `EEXIST` is retried). There is no automatic takeover: on timeout the error names the lock file and its holder, and the user deletes it when no rooster process is running.
   - An invocation pins its profile and a snapshot of that profile's other settings (server, org, locale) on first use, so a concurrent edit of `config.toml` never moves a running command to another profile or org.
   - Reads resolve the ref from a fresh config read (credential fields only; a changed server origin fails closed), read the secret, and check the ref again. A change is retried up to 3 times, then exits 5. A recorded keychain that can't be read fails closed and never falls back. A token is used only when the stored origin, the profile's origin and the origin of the request being sent are the same.
   - Logout captures the ref, revokes the grant with that captured token only, and deletes exactly that ref, confirmed or exit 1. It then clears the profile only if it still points at that ref; otherwise the newer login is kept and logout exits 5. A profile without `credential_store` has no login.
   - The CLI was never released, so there is no migration from earlier formats.
   - The compiled binaries always use the file, which keeps cross-compilation deterministic.
8. **Opening things is argv-only.** The browser opens only https URLs (http only for loopback) on the profile's server origin, through `xdg-open`, `open` or `rundll32 url.dll,FileProtocolHandler`, never a shell; anything else is printed. `$VISUAL`/`$EDITOR` is split into argv and run without a shell. User content is stripped of control and bidi characters before printing.
9. **`logout`** revokes the current grant when it is a device login. A PAT is only forgotten locally, since CI may use it elsewhere; the CLI points to `rooster token revoke`.
10. **Distribution.**
    - `dist/rooster.mjs` bundles everything except the optional keychain addon, so it has no runtime dependencies besides it.
    - Single-file binaries for Linux x64/arm64, macOS arm64/x64 and Windows x64 are built with Bun in the release workflow, smoke-tested on each OS, and attached to the GitHub release.
