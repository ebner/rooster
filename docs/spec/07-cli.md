# 07: CLI, TUI & MCP

The `rooster` binary lives in `apps/cli`. It uses only the public REST API (`packages/api-client`). It never touches the DB directly, so the CLI works against any remote instance.

## 1. Distribution
- An npm package `@rooster/cli` (Node ≥ 22), with the bin name `rooster`, built with tsdown.
- Single-file binaries via `bun build --compile` for linux-x64, linux-arm64, darwin-arm64, darwin-x64 and windows-x64, attached to releases.
  - Bun is used **only as a build tool** for these binaries. The server runs on Node (04 §2).
  - The native `@napi-rs/keyring` addon is loaded with a dynamic `import()` inside `try`/`catch`. If a compiled binary cannot load it for a target, the CLI uses the 0600 credentials-file fallback and prints a one-time notice.
  - CI runs `rooster login --with-token` and `rooster whoami` against each binary to verify that the credential storage works.
- `rooster --version` prints the CLI version and, when logged in, the server version. A warning is shown if the major API versions differ.

## 2. Configuration & auth

- **Config file:** `$XDG_CONFIG_HOME/rooster/config.toml` (default `~/.config/rooster/config.toml`; Windows `%APPDATA%\rooster\config.toml`).

  ```toml
  default_profile = "home"
  [profiles.home]
  server = "https://rooster.example.com"
  org = "personal"            # default org slug
  locale = "en"               # optional; falls back to server user setting / $LANG
  [profiles.work]
  server = "https://rooster.example.com"
  org = "northwind"
  ```

- **Secrets:** the OS keychain via `@napi-rs/keyring` (service `rooster`, account `<profile>`). The fallback is `~/.config/rooster/credentials` (mode 0600) when no keychain is available, for example in headless Linux or a container.
- **Env overrides:** `ROOSTER_SERVER`, `ROOSTER_TOKEN` (a PAT, which takes precedence), `ROOSTER_ORG`, `ROOSTER_PROFILE`, `NO_COLOR`.
- `rooster login [--server URL] [--profile NAME]`:
  1. `GET /api/v1/meta` (validates the server).
  2. A device authorisation request (client ID `rooster-cli`). Prints the verification URL and the user code, and opens the browser if possible (`--no-browser` to skip).
  3. Polls until it is approved, denied or expires.
  4. Stores the token and fetches `/me` to choose the default org.
- `rooster login --with-token` reads a PAT from stdin (for CI).
- `rooster logout` revokes the device session server-side and deletes the local secret.

## 3. Task references
Commands that take `<ref>` accept:
- `42`: the task `seq` in the current org (primary; shown in every listing).
- `personal#42`: the seq in another org.
- `0192f3a0`: a UUID prefix of at least 8 characters, unique across the user's orgs.
- `@last`: the last task created or shown by this CLI (stored in a state file).
- `-` reads refs from stdin, one per line, which enables piping: `rooster ls --json | jq -r '.[].seq' | rooster done -`.

## 4. Commands

Global flags: `--org <slug>`, `--profile <name>`, `--json`, `--quiet` (IDs only), `--no-color`, `--yes` (skip confirms), `--verbose`.

| Command | Description |
|---|---|
| `rooster` | On a TTY, opens the **TUI**. Otherwise it is the same as `rooster ls`. |
| `rooster ls [view]` | View is `my` (default), `today`, `week`, `overdue`, `nodate` or `everyone`. Flags: `--group <name>`, `--tag <t>`, `--completed`, `--all-orgs`, `--subtasks`. The human output is grouped by group headers. |
| `rooster today` / `rooster week` | Aliases. |
| `rooster add <title…>` | The title is NL-parsed server-side (`parse:true`), e.g. `rooster add "Book dentist fri #health >Today"`. **Quote the title**: unquoted, `#` starts a shell comment and `>` redirects output. Multiple unquoted words are joined with spaces, but the docs and `--help` always show the quoted form. Flags: `--due <phrase\|date>`, `--time HH:MM`, `--start <date>`, `--group <name>`, `--top`/`--bottom` (default top of the group, or the Inbox when no group is given), `--tag <t>` (repeatable), `--assign <email\|name\|me>`, `--parent <ref>`, `--desc <text>`, `--desc-file <path\|->`, `--no-parse`. It prints the created task line. |
| `rooster show <ref>` | Full details: Markdown description rendered for the terminal, subtasks, tags and (P6) recent comments. |
| `rooster edit <ref>` | `--title`, `--due <phrase\|none>`, `--time`, `--start`, `--desc`, `--desc-file`, `--editor` (opens `$EDITOR` with the description; saves on exit), `--assign`, `--parent <ref\|none>`. |
| `rooster done <ref…>` / `rooster undone <ref…>` | Complete or reopen. Shows the next recurrence when one is created. |
| `rooster mv <ref…> --group <name>` | `--top` (default) / `--bottom` / `--after <ref>` / `--before <ref>`. |
| `rooster rm <ref…>` | Soft delete (asks for confirmation when more than 3 tasks, unless `--yes`). `rooster restore <ref>`. |
| `rooster sub <parent-ref> <title…>` | Add a subtask (shorthand for `add --parent`). |
| `rooster group ls\|add <name> [--after <name>]\|rename <name> <new>\|mv <name> --after\|--before <name>\|rm <name> [--move-to <name>\|--delete-tasks]` | Group management. |
| `rooster tag ls\|add <name> [--color]\|rm <name>` · `rooster tag <ref> +urgent -later` | Tag management and tagging. |
| `rooster comment <ref> <text…>` | P6. |
| `rooster search <query…>` | `--all-orgs`. |
| `rooster open [ref]` | Opens the web UI (task deep link, or My tasks). |
| `rooster org ls` / `rooster org use <slug>` | List orgs or set the profile's default org. |
| `rooster token create <name> [--read-only] [--expires 90d]` / `ls` / `revoke <id>` | PATs. |
| `rooster mcp [--read-only]` | Starts the MCP server on stdio (§6). |
| `rooster completion bash\|zsh\|fish\|powershell` | Shell completions, including dynamic completion of group and tag names (cached for 60 s). |
| `rooster whoami`, `rooster config get\|set\|path`, `rooster logout` | Utilities. |

### 4.1 Output
Human `ls` output follows the web's look:

```
Personal · My tasks
Today (3)
   41  ○ Reply to Anna about invoice   #mail          Today
   57  ○ Book dentist                                 Tomorrow
   58  ○ Review PR #142                 ▸ 1/3         Fri
Prio (2)
   12  ○ Write Q4 plan                                 Oct 12
   33  ○ Renew passport
```

- Colours come from Coop tokens via `packages/tokens` (truecolor if supported, otherwise the nearest ANSI). The date colours follow 03 §2.3.
- `--json` emits API DTOs. `ls --json` emits `{groups, tasks}` for `my` and an array otherwise. Field names are stable (the API DTO contract).

### 4.2 Exit codes
`0` ok · `1` unexpected · `2` usage · `3` auth (not logged in, expired, forbidden scope) · `4` not found or ambiguous ref · `5` conflict or validation · `6` network or server unavailable.

### 4.3 Localisation
CLI messages come from `packages/i18n` (namespace `cli`), using the locale from the profile, then the server user setting, then `$LANG`.

## 5. TUI (`rooster` with no args, P9)

Built with **Ink 8**. It is a full-screen, keyboard-only mini rooster.

```
┌ rooster ─ Personal ▾ ───────────────────────────── ● synced ┐
│ My tasks │ Today 4 │ 7 days │ Overdue 1 │ No date           │
├─────────────────────────────────────────────────────────────┤
│ ▾ Today (3)                                                 │
│ › ○ Reply to Anna about invoice  #mail             Today    │
│   ○ Book dentist                                   Tomorrow │
│ ▾ Prio (2)                                                  │
│   ○ Write Q4 plan                ▸ 2/5             Oct 12   │
├─────────────────────────────────────────────────────────────┤
│ j/k move  enter edit  n new  x done  d date  m move  ? help │
└─────────────────────────────────────────────────────────────┘
```

- **Keymap:** vim-style, modelled on the web's Navigate mode (02 §6) but **not identical**, because terminals cannot reliably distinguish `Ctrl+Enter` or `Ctrl+J` from Enter. The differences from the web are deliberate and listed in the TUI `?` help.

  | Keys | Action | Web equivalent |
  |---|---|---|
  | `j`/`k`, ↑/↓ | move the selection | same |
  | `Enter`, `i` | edit the title | same |
  | `n` / `N` | new task below / above | same |
  | `x` | complete or reopen | web: Ctrl+Enter (on the web `x` toggles selection) |
  | `d` · `t` · `m` · `s` | date · tag · move to group · add subtask | same |
  | `o` | detail view | same |
  | `J` / `K` | move the task down / up | web: Ctrl+↓/↑ |
  | `]` / `[` | move the task to the next / previous group | web: Ctrl+Shift+↓/↑ |
  | `u` / `Ctrl+R` | undo / redo | web: Ctrl+Z / Ctrl+Shift+Z |
  | `/` | search | same |
  | `g` then `m\|t\|w\|o\|n\|e` | switch view | same |
  | `1`–`9` | switch org | web: Ctrl+1…9 |
  | `?` | help | same |
  | `q`, `Ctrl+C` | quit | web: `q` is quick add |
- **Detail view:** a split on the right when the terminal is ≥ 120 columns wide, otherwise full screen. `e` opens the description in `$EDITOR`.
- **Live updates:** an SSE connection. External changes re-render, keeping the selection by task ID.
- **Offline:** not supported. The status shows "offline" and mutations fail with a retry prompt.

## 6. MCP server (`rooster mcp`, P9)

- `@modelcontextprotocol/sdk` over stdio, authenticated with the stored profile token. Each tool takes an optional `org` slug, defaulting to the profile org.
- Example MCP client config: `{"command":"rooster","args":["mcp"]}`.

| Tool | Input | Notes |
|---|---|---|
| `list_orgs` | — | |
| `list_tasks` | `{org?, view?: my\|today\|week\|overdue\|nodate\|everyone, group?, tag?, includeCompleted?}` | Returns compact rows: seq, title, due, group, tags. |
| `get_task` | `{ref}` | Includes description and subtasks. |
| `search_tasks` | `{query, allOrgs?}` | |
| `create_task` | `{title, due?, group?, tags?, description?, parent?, assignee?}` | `due` accepts NL phrases. |
| `update_task` | `{ref, title?, due?, description?, assignee?}` | |
| `complete_task` | `{ref, completed?: boolean}` | |
| `move_task` | `{ref, group, position?: top\|bottom}` | |
| `list_groups` / `create_group` | | |
| `add_comment` | `{ref, body}` | P6. |

- **Resources:** `rooster://{org}/my` (a Markdown rendering of My tasks), usable as context.
- **Safety:** there is no delete tool. `--read-only` exposes only the list, get and search tools. Every mutation is attributed to the token's user and appears in the activity log with `via: "mcp"`.
- Future (not in scope): a remote MCP endpoint (streamable HTTP plus OAuth) on the server.
