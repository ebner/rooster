# ADR 0044: MCP tools, `rooster mcp setup` and the skill

- Status: accepted
- Date: 2026-10-09
- Amends: 07 §4, §6; 11 §5–§6.2
- Code: `packages/mcp/src/{tools,server,context,format,skill}.ts`, `apps/cli/src/commands/{mcp,skill,admin,auth}.ts`, `apps/cli/src/{safe-write,mcp-config}.ts`

## Decisions
1. **"Assignee is me"** (`isAssigneeMe`, used by `requiredScopes`):
   - Me means `me`/`mig`, the user's id, or exactly the user's email or name (case-insensitive, trimmed). Anything else also needs `tasks:assign`, including unassigning.
   - A nickname is therefore over-asked; the server still enforces the real rule.
   - `requiredScopes` returns the base scope first, then `tasks:assign`, so one challenge carries the whole need.
   - An `@name` token inside a title is resolved by the server. If it names someone else and the grant lacks `tasks:assign`, the call fails as a `forbidden_scope` tool error.
2. **Tool results are two blocks:**
   - The first is a summary in rooster's words, with no user text.
   - The second is a data block for the assistant (`audience: ['assistant']`). It starts with a fixed notice that the content is data, never instructions, and carries JSON identical to `structuredContent`.
   - Control and bidi characters are stripped. `<`, `>`, `&`, U+2028 and U+2029 are escaped as `\uXXXX`, so task text can't close the framing.
   - Rows are compact (ref with its org, title, due, overdue, group, tags, assignee when not me, completed, subtask counts, `hasDescription`). Lists stop at 200 rows with `truncated: true`.
   - Tool text is English, like API problem details: it is protocol content for the model, not UI.
3. **Errors are tool results with `isError: true`, never protocol errors:**

   | Failure | Result |
   |---|---|
   | `outside_grant` | Ask the user to widen access in Settings → Connected apps; don't retry |
   | `forbidden_scope` | Names the capability |
   | 404/410 | Not found |
   | `ambiguous_ref` | The candidates, as data |
   | 400/409/422 | The code, with details as data |
   | 401 | Set the connection up again |
   | 429 | Rate limited |
   | Anything else | A generic message, with `onError` called for logging |

4. **`create_task` puts the task at the top of its group**, including after a `>Group` token (ADR 0039 §4). `update_task` with `due` keeps a time and start date while they still fit.
5. **`rooster mcp setup` per client:**
   - `claude-code` prints `claude mcp add --scope user rooster -- <cmd> …`, the official CLI, so Claude Code's private files are never edited.
   - `claude-desktop` edits `claude_desktop_config.json`, and `cursor` edits `~/.cursor/mcp.json`; neither has an official CLI.
   - `print` (the default) prints the JSON and the command.
   - Edits merge only `mcpServers[<key>]`. An identical entry writes nothing, and a different `rooster` entry needs confirmation or `--yes`.
   - **Writing:**
     - The old file is backed up exclusively as `<file>.<stamp>.bak`.
     - The new one goes to an `O_NOFOLLOW` temp file with the existing mode (0600 for a new file), is fsynced and renamed into place.
     - The target is checked again before the rename.
     - Symlinks, non-regular files and invalid JSON are refused, and the file is left untouched.
   - The entry is only `{command, args}`, never a token.
   - **Server key, command and login:**
     - The key is `rooster` for the `agent` profile, `rooster-<profile>` otherwise.
     - The command is the absolute binary, or node plus the absolute script.
     - The login requests `tasks:read tasks:write comments:write notifications:read groups:write`, plus `tasks:delete` only with `--allow-delete`. It never becomes the default profile.
     - An existing login of the profile on the same server is reused when its delete capability matches what was asked for. `--relogin` forces a new one.
     - `ROOSTER_TOKEN` set means exit 2.
6. **`rooster mcp`** sends `X-Rooster-Client: mcp/<version>` and lists tools by the current grant's scopes (`granted`). Stdout is reserved for the protocol, and logs go to stderr.
7. **The skill:**
   - 114 lines, deterministic bytes per instance URL.
   - Front matter: `name: rooster`, the 11 §6.2 description, and `metadata.version`/`instance`.
   - Sections: Concepts, Tools, NL parsing, Workflows, Etiquette, Permissions, Setup.
   - `skillInstructions` is a four-paragraph short form.
   - **Install:**
     - `rooster skill install` writes `~/.claude/skills/rooster/SKILL.md`, or `~/.agents/skills/…` with `--target agents`. With `--project` it writes under the current directory, and refuses any symlink below it (planted links in a cloned repo).
     - In the home directory only the `rooster` folder and the file itself must not be links, so a dotfiles-linked `~/.claude` works.
     - The write is atomic, with a backup and mode 0644.
8. **`rooster admin reindex`** maps a 403 to exit 3 with the `rooster login --admin` hint. `login --admin` requests `admin` and warns when the grant comes back without it.
9. **`serverInfo`** is `{name: 'io.github.201works/rooster', title: 'rooster'}`, matching the Server Card (ADR 0043).
