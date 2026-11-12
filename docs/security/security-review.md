# Security review (Phase 11, AC-11.1)

- **Date:** 2026-10-10.
- **Reviewer:** an independent review with read-only access to the code.

## Method
- One focused review per trust boundary (09 §Phase 11). Each brief names the files, the assets and the attacks to try.
- A structured review of every change since 1.0.0.
- After each set of fixes, every boundary was reviewed again until the review reported it clean, or until the remaining findings were accepted under the triage rule below.
- The reviewer reproduced each finding with an in-memory or loopback probe. Each one was verified again before anything changed, and every fix carries a regression test that fails without it.

## Triage
The rule is in AGENTS.md → Reviews.
- **Fixed:** real problems with meaningful impact. These are exposure across accounts or of credentials, escalation, and integrity loss. Resource limits that can be reached in practice are fixed too when the fix is proportionate.
- **Accepted:** anything that needs a trusted component (the operator's S3, IdP or proxy) to misbehave. Also accepted are rare timing windows between tabs that expose nothing to another account.
- Each accepted finding is listed below with its reason. The decisions that change behaviour are in ADR 0056.

The session barrier (ADR 0051) came out of the review of the late Phase 10 commits, just before this audit.

## Columns
- **Severity:** as the review reported it; P1 is high, P2 medium, P3 low.
- **ASVS:** the ASVS 4.0.3 requirement the review cited. The map is `docs/security/asvs.md`.
- **Round:** the review round that found the issue.

## Summary

| Boundary | Findings | Fixed | Accepted or refuted | Final re-check |
|---|---|---|---|---|
| 1. Sign-in, sessions and account linking | 9 | 9 | 0 | Clean (round 5) |
| 2. The OAuth 2.1 AS, CIMD and token audiences | 11 | 11 | 0 | Clean (round 5) |
| 3. Grants and service authorisation | 23 | 23 | 0 | Clean (round 7) |
| 4. `/mcp` and discovery | 0 | 0 | 0 | Clean (round 1) |
| 5. Uploads, blobs, avatars and calendar feeds | 10 | 8 | 2 | Clean (round 7) |
| 6. Push, mail and outbound SSRF guards | 6 | 6 | 0 | Clean (round 4) |
| 7. Realtime (SSE) and request middleware | 3 | 3 | 0 | Clean (round 3) |
| 8. The web client | 26 | 23 | 3 | Triaged: the last narrow check found 2 gaps (fixed), 1 refuted, 1 accepted |
| 9. The CLI | 8 | 8 | 0 | Clean (round 4) |
| 10. Backups, admin, config and the Docker image | 6 | 6 | 0 | Clean (round 4) |
| Structured pass over everything since v1.0.0 | 5 | 5 | 0 | Findings fixed with the web boundary |
| **Total** | **107** | **102** | **5** | |

## 1. Sign-in, sessions and account linking

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P1 | Reserve `google` even when built-in Google is disabled (`apps/server/src/auth/auth.ts:164-167`) | 4.1.2 | Fixed: 8e24cdc, 291a526 |
| 1 | P1 | Prevent automatic relinking of explicitly removed identities (`apps/server/src/services/identity-service.ts:81-81`) | 4.1.5 | Fixed (ADR 0056): bea4d31, migration 0014 |
| 1 | P2 | Enforce provider trust on the ID-token linking path (`apps/server/src/auth/auth.ts:385-391`) | 1.4.4 | Fixed: 8e24cdc |
| 1 | P2 | Apply the host-only prefix to OAuth state cookies (`apps/server/src/auth/auth.ts:490-495`) | 3.4.4 | Fixed: 8e24cdc |
| 1 | P2 | Disable unused endpoints that export provider credentials (`apps/server/src/auth/auth.ts:68-74`) | 3.2.3 | Fixed: 8e24cdc |
| 1 | P3 | Normalize account-existence errors for unverified emails (`apps/server/src/auth/mount.ts:31-35`) | 7.4.1 | Fixed: 8e24cdc |
| 2 | P2 | Disable the session-list endpoint that exports device tokens (`apps/server/src/auth/auth.ts:87-92`) | 4.0.3 | Fixed: dbc6b2e |
| 3 | P2 | Normalize HTTPS detection before selecting auth cookie names (`apps/server/src/auth/auth.ts:588-590`) | 4.0.3 | Fixed: d15cd24, 7cfb516 |
| 4 | P2 | Disable provider logout to prevent ID-token export (`apps/server/src/auth/auth.ts:90-92`) | 4.0.3 | Fixed: cc123f4 |

## 2. The OAuth 2.1 AS, CIMD and token audiences

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P1 | Make consent rollback atomic across overlapping decisions (`apps/server/src/services/grant-service.ts:1482-1483`) | 4.0.3 | Fixed: 8e24cdc |
| 1 | P1 | Bind consent approval to the account shown on the page (`apps/server/src/routes/oauth.ts:144-147`) | 4.0.3 | Fixed: 8e24cdc |
| 1 | P2 | Enforce the authorization-details ceiling in the service (`apps/server/src/services/grant-service.ts:1384-1384`) | 4.0.3 | Fixed: 8e24cdc |
| 2 | P1 | Verify genuine code issuance before committing consent (`apps/server/src/routes/oauth.ts:196-197`) | 4.0.3 | Fixed: dbc6b2e |
| 2 | P1 | Preserve restrictions applied while consent is pending (`apps/server/src/services/grant-service.ts:1542-1548`) | 4.0.3 | Fixed: dbc6b2e |
| 2 | P2 | Bind each displayed consent to a session-specific decision nonce (`apps/server/src/services/grant-service.ts:276-278`) | 4.0.3 | Fixed: dbc6b2e |
| 2 | P2 | Fail closed when a signed constraint ceiling becomes stale (`apps/server/src/services/grant-service.ts:1443-1444`) | 4.0.3 | Fixed: dbc6b2e |
| 3 | P1 | Bind the issued code to this specific consent attempt (`apps/server/src/services/grant-service.ts:1627-1630`) | 4.0.3 | Fixed: 0549c52 |
| 3 | P2 | Restore provider consent after rejecting a staged step-up (`apps/server/src/services/grant-service.ts:1659-1661`) | 4.0.3 | Fixed: 0549c52 |
| 4 | P2 | Preserve concurrent scope narrowing when restoring consent (`apps/server/src/services/grant-service.ts:1748-1748`) | 4.0.3 | Fixed: cc123f4 |
| 4 | P2 | Restore provider consent when issuance throws (`apps/server/src/services/grant-service.ts:1733-1735`) | 4.0.3 | Fixed: cc123f4 |

## 3. Grants and service authorisation

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P1 | Restrict permanent deletion beyond the soft-delete grant (`apps/server/src/services/task-service.ts:1263-1266`) | 4.0.3 | Fixed: 8e24cdc |
| 1 | P2 | Require task-write permission when splitting a group (`apps/server/src/services/group-service.ts:133-136`) | 4.0.3 | Fixed: 8e24cdc |
| 1 | P2 | Apply organization-wide authorization to implicit tag creation (`apps/server/src/services/tag-service.ts:125-128`) | 4.0.3 | Fixed: 8e24cdc |
| 1 | P2 | Remove member emails from grant-authorized responses (`apps/server/src/services/org-service.ts:402-404`) | 4.0.3 | Fixed (ADR 0056): d0ffa65, `/members/resolve` |
| 1 | P2 | Prevent OAuth apps from listing unrelated grants (`apps/server/src/services/grant-service.ts:731-736`) | 4.0.3 | Fixed: 8e24cdc |
| 1 | P3 | Build pagination cursors only from authorized records (`apps/server/src/services/task-service.ts:1899-1901`) | 4.0.3 | Fixed: 8e24cdc |
| 1 | P3 | Check destination visibility before revealing its group name (`apps/server/src/services/grant-access.ts:220-225`) | 4.0.3 | Fixed: 8e24cdc |
| 2 | P2 | Exclude colleague emails from grant-authorized search matching (`apps/server/src/services/search-service.ts:188-193`) | 4.0.3 | Fixed: dbc6b2e |
| 2 | P2 | Bind device approval to the account shown during review (`apps/server/src/services/grant-service.ts:1203-1207`) | 4.0.3 | Fixed: dbc6b2e |
| 2 | P3 | Derive activity cursors only from visible entries (`apps/server/src/services/activity-service.ts:215-217`) | 4.0.3 | Fixed: dbc6b2e |
| 2 | P3 | Check group readability before authorizing group mutations (`apps/server/src/services/group-service.ts:195-196`) | 4.0.3 | Fixed: dbc6b2e |
| 3 | P2 | Authorize every descendant before group deletion and restoration (`apps/server/src/services/group-service.ts:305-307`) | 4.0.3 | Fixed: d15cd24 |
| 3 | P3 | Check group readability before returning an existing create (`apps/server/src/services/group-service.ts:124-127`) | 4.0.3 | Fixed: d15cd24 |
| 3 | P3 | Exclude unreadable subtasks from aggregate counts (`apps/server/src/services/list-access.ts:254-258`) | 4.0.3 | Fixed: d15cd24 |
| 3 | P3 | Redact parent references when the parent is unreadable (`apps/server/src/services/list-access.ts:306-307`) | 4.0.3 | Fixed: d15cd24 |
| 3 | P3 | Hide unreadable group names in constraint-error explanations (`apps/server/src/services/grant-access.ts:672-676`) | 4.0.3 | Fixed: d15cd24 |
| 4 | P2 | Check children's readability before reconciling placements (`apps/server/src/services/grant-access.ts:486-491`) | 4.0.3 | Fixed: cc123f4 |
| 4 | P3 | Authorize existing tasks before comparing retry content (`apps/server/src/services/task-service.ts:1535-1539`) | 4.0.3 | Fixed: cc123f4 |
| 4 | P3 | Authorize the split task before checking its deletion state (`apps/server/src/services/group-service.ts:145-146`) | 4.0.3 | Fixed: cc123f4 |
| 5 | P2 | Authorize the existing parent before duplicating a subtask (`apps/server/src/services/task-service.ts:1564-1564`) | 4.0.3 | Fixed: 0843c44 |
| 5 | P2 | Detach restored group tasks from parents still in Trash (`apps/server/src/services/group-service.ts:410-414`) | 4.0.3 | Fixed: 0843c44 |
| 6 | P2 | Authorize the parent before continuing a subtask series (`apps/server/src/services/recurrence-service.ts:115-123`) | 4.0.3 | Fixed: f026c94 |
| 6 | P3 | Re-home restored tasks whose groups remain deleted (`apps/server/src/services/group-service.ts:438-440`) | 4.0.3 | Fixed: f026c94 |

## 4. `/mcp` and discovery

No finding. The first review verified:

- Origin checks;
- token audiences and revocation;
- scope enforcement;
- batch accounting;
- rate and body limits;
- grant-constrained in-process access;
- credential stripping;
- the framing of untrusted content;
- discovery isolation;
- the SKILL.md digest.

## 5. Uploads, blobs, avatars and calendar feeds

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P2 | Bound temporary upload storage before streaming (`apps/server/src/services/attachment-service.ts:128-136`) | 4.0.3 | Fixed: a6426f5 |
| 1 | P2 | Bind avatar reads to the backend of the current upload (`apps/server/src/services/avatar-service.ts:166-169`) | 4.0.3 | Fixed: a6426f5 |
| 2 | P2 | Refresh in-flight quota budgets when another upload commits (`apps/server/src/services/attachment-service.ts:146-150`) | 4.0.3 | Fixed: 1ae6c95 |
| 2 | P2 | Bind avatar reads to a specific storage location or generation (`apps/server/src/services/avatar-service.ts:195-196`) | 4.0.3 | Fixed: 1ae6c95 |
| 3 | P2 | Preserve avatar generation uniqueness across removals (`apps/server/src/services/avatar-service.ts:53-54`) | 4.0.3 | Fixed: 7d9229a |
| 4 | P2 | Retain avatar upload slots until storage completes (`apps/server/src/services/avatar-service.ts:113-114`) | 4.0.3 | Fixed: 0531f97 |
| 5 | P2 | Bound DELETE requests waiting on the avatar lock (`apps/server/src/services/avatar-service.ts:108-110`) | 4.0.3 | Fixed: 242f862 |
| 6 | P2 | Close the source file stream after every S3 PUT (`apps/server/src/blob/s3-store.ts:97-103`) | 4.0.3 | Fixed: f331590 |
| 6 | P2 | Keep an idle timeout active throughout S3 response bodies (`apps/server/src/blob/s3-store.ts:57-60`) | 4.0.3 | Accepted: needs the operator's own S3 to stall, and a cut-off would hit slow clients |
| 6 | P2 | Queue uncertain S3 writes for garbage collection (`apps/server/src/services/avatar-service.ts:130-134`) | 4.0.3 | Accepted: a rare lost S3 answer only costs storage |

## 6. Push, mail and outbound SSRF guards

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P2 | Revalidate scheduled deliveries after they leave the queue (`apps/server/src/mail/mail-service.ts:398-399`) | 4.1.3 | Fixed: a6426f5 |
| 1 | P2 | Apply the delivery limit to each push subscription (`apps/server/src/push/push-service.ts:355-355`) | 11.1.2 | Fixed: a6426f5 |
| 1 | P3 | Strip SMTP response text before logging delivery errors (`apps/server/src/mail/transport.ts:29-30`) | 7.1.2 | Fixed: a6426f5 |
| 2 | P2 | Preserve the CIMD deadline until the underlying response closes (`apps/server/src/auth/cimd-fetch.ts:251-255`) | 4.0.3 | Fixed: 1ae6c95 |
| 2 | P2 | Recheck push preferences before each queued notification send (`apps/server/src/push/push-service.ts:348-350`) | 4.0.3 | Fixed: 1ae6c95 |
| 3 | P2 | Bound queued push work as well as concurrent sends (`apps/server/src/push/push-service.ts:342-343`) | 4.0.3 | Fixed: 7d9229a |

## 7. Realtime (SSE) and request middleware

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P1 | Bound chunk allocation in the request-body limiter (`apps/server/src/lib/body-limit.ts:16-18`) | 4.0.3 | Fixed: a6426f5, 291a526 |
| 1 | P2 | Bound pending SSE writes and abort stalled transports (`apps/server/src/routes/events.ts:89-92`) | 4.0.3 | Fixed: a6426f5, 291a526 |
| 2 | P2 | Destroy evicted SSE sockets even when the frame queue is empty (`apps/server/src/events/sse-transport.ts:98-104`) | 4.0.3 | Fixed: 1ae6c95 |

## 8. The web client

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P1 | Initialize cleanup dependencies before replaying clear messages (`apps/web/src/data/sync/engine.ts:394-394`) | 4.0.3 | Fixed: 406e7d8 |
| 1 | P1 | Discard cache restoration results after the startup timeout (`apps/web/src/data/sync/engine.ts:239-240`) | 4.0.3 | Fixed: 406e7d8 |
| 2 | P2 | Scope push registration to the session that started it (`apps/web/src/data/push.ts:238-239`) | 4.0.3 | Fixed: 5e5c2e6 |
| 2 | P2 | Invalidate pending pipeline work when the session expires (`apps/web/src/data/sync/engine.ts:549-553`) | 4.0.3 | Fixed: 5e5c2e6 |
| 3 | P2 | Unsubscribe pending push registrations when the session clears (`apps/web/src/data/push.ts:240-244`) | 4.0.3 | Fixed: cf13647 |
| 3 | P2 | Close the pipeline before the final sign-out wipe (`apps/web/src/data/sync/engine.ts:710-715`) | 4.0.3 | Fixed: cf13647 |
| 4 | P2 | Unsubscribe unmarked push registrations on failure (`apps/web/src/data/push.ts:303-304`) | 4.0.3 | Fixed: dbc6b2e |
| 4 | P2 | Extend the sign-out barrier to other tabs' durable writes (`apps/web/src/data/sync/engine.ts:716-718`) | 4.0.3 | Fixed: dbc6b2e |
| 5 | P2 | Remove late cross-tab cache snapshots during sign-out (`apps/web/src/data/sync/engine.ts:671-675`) | 4.0.3 | Fixed: e36b633 |
| 5 | P2 | Clear secret-bearing mutation results on session expiry (`apps/web/src/data/sync/engine.ts:553-555`) | 4.0.3 | Fixed: e36b633 |
| 6 | P2 | Remove the old snapshot when /me detects an account switch (`apps/web/src/data/sync/engine.ts:497-498`) | 4.0.3 | Fixed: f998950 |
| 6 | P2 | Make owner-conditional snapshot deletion atomic (`apps/web/src/data/sync/persist.ts:226-229`) | 4.0.3 | Fixed: f998950 |
| 6 | P2 | Sweep late localStorage writes in receiving tabs (`apps/web/src/data/sync/engine.ts:682-685`) | 4.0.3 | Fixed: f998950 |
| 7 | P2 | Fence startup housekeeping against ownership changes (`apps/web/src/data/sync/persist.ts:280-280`) | 4.0.3 | Fixed: 381a77b |
| 7 | P2 | Scope session-expiry cleanup to the ending account (`apps/web/src/data/sync/engine.ts:550-554`) | 4.0.3 | Fixed: 381a77b |
| 8 | P2 | Remember the stored account when expiry follows a restore timeout (`apps/web/src/data/sync/engine.ts:564-564`) | 4.0.3 | Fixed: 011be30 |
| 8 | P2 | Fence old-tab outbox cleanup before enabling the new account (`apps/web/src/data/sync/engine.ts:503-505`) | 4.0.3 | Fixed: 011be30 |
| 9 | P2 | Propagate session expiry to other tabs and fence their saves (`apps/web/src/data/sync/engine.ts:569-570`) | 4.0.3 | Fixed: 7134a31 |
| 10 | P2 | Persist the expiry fence across tabs and reloads (`apps/web/src/data/sync/persist.ts:275-277`) | 4.0.3 | Accepted: a millisecond window before a closing tab processes `expired`; the next online start's 401 deletes the copy |
| 10 | P2 | Keep expired-session edits owned by their original account (`apps/web/src/data/sync/engine.ts:235-235`) | 4.0.3 | Fixed: ad6c207 |
| 11 | P2 | Recheck the send gate after pending persistence completes (`apps/web/src/data/sync/engine.ts:235-237`) | 4.0.3 | Fixed: d12f2b2 |
| 12 | P2 | Bound description nesting and recover from parsing failures (`apps/web/src/features/editor/markdown.ts:168-168`) | 4.0.3 | Fixed: 16421eb |
| 13 | P1 | Close the remaining middleware-to-fetch session race (`apps/web/src/data/pipeline/pipeline.ts:773-775`) | — | Refuted: a session ends only on a macrotask (a `/me` response), which can't run between openapi-fetch's awaited middleware and `fetch`; the probe forced a microtask into the gap. At most it is ADR 0051's accepted window. |
| 13 | P2 | Handle parse failures in deferred blur callbacks (`apps/web/src/features/pane/description-field.tsx:122-124`) | — | Fixed: e66f84e |
| 13 | P2 | Synchronize pristine fallback text with incoming descriptions (`apps/web/src/features/pane/description-field.tsx:145-147`) | — | Fixed: e66f84e |
| 13 | P2 | Preserve literal code while bounding container nesting (`apps/web/src/features/editor/markdown.ts:229-231`) | — | Accepted: only code samples nested more than 20 levels deep gain an escape backslash |

## 9. The CLI

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P2 | Parse inline Markdown without pathological backtracking (`apps/cli/src/output/markdown.ts:13-16`) | 4.0.3 | Fixed: 257a12e |
| 1 | P2 | Quote generated Windows commands for a specific shell (`apps/cli/src/mcp-config.ts:200-204`) | 4.0.3 | Fixed: 257a12e |
| 1 | P2 | Clean server-supplied login codes and version strings (`apps/cli/src/commands/auth.ts:207-209`) | 4.0.3 | Fixed: 257a12e |
| 1 | P2 | Validate task reference metadata before rendering it (`apps/cli/src/output/format.ts:144-146`) | 4.0.3 | Fixed: 257a12e |
| 1 | P2 | Reject explicit scope lists that contain no scopes (`apps/cli/src/grant-info.ts:26-28`) | 4.0.3 | Fixed: 257a12e |
| 2 | P2 | Sanitize verbose exception stacks before printing (`apps/cli/src/run.ts:100-101`) | 4.0.3 | Fixed: 4bce6ae, 291a526 |
| 2 | P2 | Reject malformed credentials without echoing their contents (`apps/cli/src/run.ts:99-99`) | 4.0.3 | Fixed: 4bce6ae, 291a526 |
| 3 | P2 | Catch and sanitize asynchronous TUI failures (`apps/cli/src/tui/controller.ts:380-383`) | 4.0.3 | Fixed: 97942e3 |

## 10. Backups, admin, config and the Docker image

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P2 | Keep application files owned by root (`docker/Dockerfile:70-70`) | 4.0.3 | Fixed: a6426f5 |
| 1 | P2 | Exclude Litestream credentials from the web container (`compose.yaml:9-9`) | 4.0.3 | Fixed: a6426f5 |
| 1 | P2 | Abort startup when database permission hardening fails (`apps/server/src/db/boot.ts:45-48`) | 4.0.3 | Fixed: a6426f5 |
| 1 | P2 | Protect the environment file before populating secrets (`docs/operator.md:37-39`) | 4.0.3 | Fixed: a6426f5 |
| 2 | P2 | Exclude the Litestream credentials file from build contexts (`compose.litestream.yaml:43-43`) | 4.0.3 | Fixed: 1ae6c95 |
| 3 | P2 | Exclude nested runtime data from Docker build contexts (`.dockerignore:14-14`) | 4.0.3 | Fixed: 54d662d |

## Structured pass over everything since v1.0.0

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P2 | Prevent preference rollbacks from restoring an expired session (`apps/web/src/data/notifications.ts:249-250`) | — | Fixed: 406e7d8 |
| 1 | P2 | Preserve renewal eligibility when rotating push keys (`apps/server/src/push/push-service.ts:300-302`) | — | Fixed: a6426f5 (supersedes ADR 0040 §4, bullet 3) |
| 1 | P2 | Retain and retry failed push renewals on app open (`apps/web/src/data/push.ts:319-321`) | — | Fixed: 406e7d8 |
| 1 | P2 | Apply recurrence patches to the Everyone cache (`packages/core/src/everyone.ts:383-386`) | — | Fixed: 406e7d8, a784388 |
| 1 | P2 | Include reminder-affecting patches in the detail filter (`apps/web/src/data/task-detail.ts:29-33`) | — | Fixed: 406e7d8 |

## Accepted risks
These are also recorded in ADR 0056.
- **An S3 response body that stalls after its headers.** This needs the operator's own backend to misbehave. An idle cut-off would also hit slow clients, and the socket timeout already bounds idle connections.
- **An S3 object orphaned when a PUT's answer is lost.** It is rare, and costs only storage.
- **A tab that closes before it processes another tab's `expired` message** can save its account's offline copy once more. The window is milliseconds, and the next online start's 401 deletes the copy.
- **Avatars uploaded by 1.4.x** keep the shared-key fallback until they are replaced. The key is per user, so at worst a stale copy of the same user's earlier avatar is shown.
- **Push endpoints that differ only in percent-encoding** count as separate devices. Normalising them would break real endpoints such as WNS, and the cap of 20 devices bounds the risk.
- **The nesting bound may add an escape backslash** inside code samples nested more than 20 levels deep.
- **`/members/resolve`** confirms that an address the caller already knows belongs to a member. It is rate-limited, and inherent to assigning by email.
- **Requests sent before a tab learns of an account switch** carry the new cookie (ADR 0051).

## Phase 12: the device grant, MCP tokens and the CLI login (2026-10-21)

Reviewed commits: ee80672 (contract), dde30f2 (server), 878526e (CLI), 487d953 (web), and the fixes after them.

**Method:**
- **Independent review:** a structured review of every commit, and a focused review per part (server, CLI, web).
- **Audit:** a second, adversarial security review ran over the server, CLI and web commits. Its findings are marked "audit" below.
- **Every fix carries a regression test** that fails without it.

| # | Part | Severity | Finding | Source | Outcome |
|---|---|---|---|---|---|
| 1 | Server | P2 | Revoking a stale `rooster-cli` refresh token ran better-auth's client-wide cleanup and ended every CLI login of the user | Structured | Fixed in fca8173 |
| 2 | Server | P2 | A CLI admin login refreshing with the `admin` scope it was given got `invalid_scope` | Structured | Fixed in fca8173 |
| 3 | CLI | P2 | A 200 token response whose body was cut off wasn't retried, so the grace window was missed | Structured | Fixed in 9e79497 |
| 4 | Web | P2 | A device reconnect sent retained scopes and failed with `422 widening_not_allowed` | Structured and focused | Fixed in 54e4a86 |
| 5 | Web | Medium | `?user_code=` pre-filled the code, so approval was "Enter, then Allow" | audit | Fixed in 1f92597 (ADR 0066 §13) |
| 6 | Web | Medium | Delete and admin started ticked for `rooster-cli` requests, and anyone can start one | audit | Fixed in 1f92597 (ADR 0066 §13a) |
| 7 | CLI | Low | Credential POSTs followed redirects; a 307/308 re-sends the body cross-origin | audit | Fixed in ff7805b |
| 8 | Server | Low | The `device_connected` notice named the device the CLI reports, which an attacker chooses | audit | Fixed in 3fbe34e |
| 9 | Server | Low | A third-party app could call itself "rooster CLI" | audit | Fixed in 3fbe34e |
| 10 | Server | Low | Pending user codes appeared in the request log | audit | Fixed in 3fbe34e |
| 11 | Server | Low | User codes (40 bits) were hashed with plain SHA-256, crackable from a database copy | audit | Fixed in 3fbe34e (HMAC with the auth secret) |
| 12 | Server | Low | The per-client limiter stored arbitrary `client_id` strings | audit | Fixed in 3fbe34e |
| 13 | Server | P2 | `PATCH /me/grants/:id` could add `admin` to an MCP token or `/mcp` login | Focused, audit | Fixed in 3fbe34e |
| 14 | Server | P1 | A refused grace retry (wrong `resource`) revived the old refresh token for good | Focused | Fixed in 3fbe34e |
| 15 | Server | P1 | A revoked, rotated app refresh token stayed redeemable through the grace window | Focused | Fixed in 3fbe34e |
| 16 | Server | P2 | `token=Bearer <rt>` on revoke bypassed the per-grant handling and ran the client-wide cleanup | Focused | Fixed in 3fbe34e |
| 17 | Server | P2 | A new grant with `notifications:read` could mark its own `device_connected` notice as read | Focused | Fixed in 3fbe34e (the notice is browser-only) |
| 18 | CLI | P1 | `mcp header` was bound only to the profile, so a client set up for server A could receive server B's token | Focused | Fixed in 8af81cf (`--server`) |
| 19 | CLI | P2 | A 4xx or 429 whose body was cut off counted as a lost refresh and was retried | Focused | Fixed in 8af81cf |
| 20 | CLI | P2 | A keychain read-back that failed after a successful write restored the spent refresh token | Focused | Fixed in 96ffa21 |
| 21 | Server | P2 | The grace rollback cleared revocations it hadn't made, reviving an access token that sign-out had revoked | Structured | Fixed in de9c408 |
| 22 | CLI | P2 | Three or more processes taking over an abandoned lock at once can briefly overlap | Structured and focused | Accepted |
| 23 | CLI | P2 | A live lock holder paused for over 120 s (SIGSTOP, a hung keychain) is taken over by age | Focused | Accepted |

**Final re-checks:** the structured re-checks of every fix commit report no actionable regression. The last focused CLI review is clean, apart from the accepted items. The focused server findings are all fixed and re-checked by the structured reviews.

### Review before publication (2026-11-02)

A focused review of the Phase 12 server (device grant, refresh grace, revocation, audiences) and a second, adversarial audit of the same code, before the repository was made public. Both reported the rest of the scope sound: code hashing and lookups, brute-force limits, decision binding and CSRF, single redemption of device codes, scope ceilings, audience isolation, the CIMD fetch and log redaction.

| # | Severity | Finding | Source | Outcome |
|---|---|---|---|---|
| 24 | P2 | A sign-out while a grace retry was in flight skipped the successor's access tokens (they looked revoked); when the retry then failed, the undo made them valid again until expiry | Focused | Fixed: the undo leaves tokens of an ended session revoked |
| 25 | Medium | The legacy CLI device login sent no `device_connected` notice, and `ROOSTER_OAUTH_DEVICE=off` leaves it on, so phishing through it skipped the notice | audit | Fixed: it sends the notice. `off` keeps it on as documented (the CLI's fallback until the next major) |
| 26 | Low | With `ROOSTER_OAUTH_DEVICE=all`, the per-client limit on device authorization requests (30 per hour) counts requests before validation, so junk requests naming one app's client id block that app's device logins for an hour | audit | Accepted: only with `all`, no exposure, bounded to an hour per app; the per-IP limit still applies |

**Re-check:** the structured and focused re-checks of the fixes (sign-out, expiry, grant and RFC 7009 revocation, deactivation, other sessions, session-only grants, sessionless CLI tokens, the refresh lock order; the notice's data and email) report no issue.

### Accepted risks (Phase 12)
- **Lock takeover races (22, 23).** They need a crashed or paused CLI process, plus concurrent commands at the moment of takeover. The worst case is a revoked grant, so the user logs in again; no credential is exposed. An OS advisory lock would fix it structurally, but Node has none without a native dependency.
- **The refresh grace window (ADR 0066).** A thief who uses a stolen refresh token within 60 s of a rotation, before the real client uses its successor, gets one pair. The theft surfaces as a revoked grant at the real client's next refresh.
- **Device-code phishing in general (ADR 0065).** A user who types a code an attacker started and approves it anyway. Mitigated by the typed code, the warning, the defaults, the browser-only notice and the operator switch.

## Dependency advisories (2026-11-12)

Dependabot reported 34 alerts on 13 packages after the repository went public (`pnpm audit`: 37). All were transitive except nodemailer and vite.

- **Shipped and fixed:**
  - nodemailer 10.0.16 → 10.4.0: address-parser bugs (GHSA-85x2-q946-cp5h, GHSA-m943-m63m-w62w, GHSA-8c8m-p3m8-cjg8). It parses the addresses of invites and notification emails.
  - seroval → 1.6.11: script injection in serialised output (TanStack Router, web app).
  - undici 7 → 7.30.2 and @ai-sdk/provider-utils → 4.0.65: inside Scalar, the API reference at `/api/docs`.
- **Build and development only, fixed anyway:** vite → 8.3.6 (dev server), undici 8 → 8.12.4 (jsdom in tests), esbuild for drizzle-kit's loader → 0.25.12, and fast-uri, serialize-javascript, glob and minimatch inside workbox-build.
- The transitive fixes are `overrides` in `pnpm-workspace.yaml`, each scoped to the vulnerable range; drop an entry once its parent ships the fix.
- **Accepted:** deepmerge 4.3.1 (GHSA-gcqx-w48m-w2h4, low, no patched version). It is reached only through `@rollup/plugin-node-resolve` in `workbox-build`, while the service worker is built from rooster's own configuration, and ships nowhere.
