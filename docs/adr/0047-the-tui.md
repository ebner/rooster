# ADR 0047: The terminal UI

- Status: accepted
- Date: 2026-10-09
- Amends: 07 §5
- Code: `apps/cli/src/tui/**`, `apps/cli/tsdown.config.ts`, `apps/cli/scripts/build-binaries.sh`

## Decisions
1. **Entry and loading.**
   - `rooster` with no arguments opens the TUI only on a raw-mode TTY. Piped stdin or stdout, no `setRawMode`, or `TERM=dumb` falls back to `rooster ls`.
   - The TUI (React, Ink 8, yoga) is a separate chunk of about 233 KB gzip, loaded by `await import()` in `runTui`, so other commands pay about 5 KB for the chunk split.
   - Ink's optional `react-devtools-core` import is never bundled (`DEV_ONLY_DEPS`), and the Bun build marks it external.
2. **Keymap.** It is one table (`KEYMAP`), and `?` help is generated from it, including a "Differences from the web" section:
   - `x` completes, where the web uses Ctrl+Enter (on the web, `x` selects).
   - `J`/`K` move a task, where the web uses Ctrl+↓/↑.
   - `]`/`[` move it to the next or previous group, where the web uses Ctrl+Shift+↓/↑.
   - `u` undoes and Ctrl+R redoes.
   - `1`–`9` switch orgs.
   - `e` opens the description in `$EDITOR`.
   - `q` quits.
   - `r` retries a failed change or refreshes.

   Additions to 07 §5: ←/→ collapse and expand, Home/End, PgUp/PgDn, Delete, `H` shows completed tasks, Esc. As on the web, Enter and Esc commit a title, Enter on a draft opens the next one, and `g` waits 1 s for its second key.
3. **Undo.**
   - It is a session-only stack of 50 inverse REST calls, for adds, titles, dates, completing, moves, tags, descriptions and deletes. Undoing an add moves the task to Trash.
   - It doesn't check for newer changes by others, and undoing a completion doesn't remove a repeating task's next instance.
   - Collapse state is saved best-effort and isn't undoable.
   - Switching org clears the stack.
4. **Live updates.**
   - SSE runs over `fetch` with the profile's bearer token, read fresh on each attempt and subject to the CLI's origin checks.
   - Reconnects back off 1/2/4/8/16/30 s like the web. A stream silent for 55 s is reconnected, and a 401 or 403 stops it with a "log in again" message.
   - `hello` after a reconnect triggers a full refetch, since there is no replay.
   - Invalidations carrying the TUI's own client id are skipped. An epoch counter drops refetches that raced the TUI's own optimistic changes, so nothing flickers.
5. **Data.**
   - The TUI calls the public API only, through `createRoosterClient` with the CLI's `cliFetch`.
   - Smart views, counts and Everyone's tasks come from core `selectView`, `viewCounts` and `selectEveryone` over the my-list payload, so they match the web exactly.
   - Moves send `{beforeId, afterId}` only.
   - `X-Rooster-Client: tui/<version>` makes activity read "via the terminal app".
6. **Detail view.** It splits at 120 columns or more, and takes over the list below that. The description is rendered from Markdown, with every server string stripped of control and bidi characters.
   - `$EDITOR` runs through `suspendTerminal` and `launch.ts`, with argv only and never a shell.
7. **Rendering.** The TUI uses the alternate screen. Ink waits 20 ms after a lone Esc, so tests space keys 30 ms apart.
   - Terminals too small to draw the TUI show a notice.

## Consequences
- Bun compiles the chunked build into one binary. An unresolved external (Ink's `react-devtools-core`) made the compiled binary fail at startup, so it is aliased to a bundled no-op (`tui/devtools-stub.ts`). This was verified locally with Bun 1.4.2 (`--version`, `ls`); the release workflow's `cli-smoke` jobs check every target.

## Amendments after the first security review
- **One identity per logical change:** each change keeps one edit time and one Idempotency-Key per write (`tui/idempotency.ts`), reused by `r`, so a lost response can't create a duplicate.
- **Typing during a pending create:** after Enter on a draft, keys are buffered until the create returns, then replayed into the next draft. They are dropped on failure, so typed text never runs as shortcuts.
- **The details follow the selection:** when the selection moves by itself, the details switch to the new task or close. Editing modes draw over the narrow details view.
- **Org switches drop stale work:** searches, mutation callbacks, undo entries and pending retries are bound to a request generation and an org, and an org switch discards them.
- **Drafts in collapsed groups:** adding from the header of a collapsed group opens the group first.
