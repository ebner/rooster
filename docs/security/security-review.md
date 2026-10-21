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
| 1 | P1 | Reserve `google` even when built-in Google is disabled (`apps/server/src/auth/auth.ts:164-167`) | 4.1.2 | Fixed: 35710d5, 83acd67 |
| 1 | P1 | Prevent automatic relinking of explicitly removed identities (`apps/server/src/services/identity-service.ts:81-81`) | 4.1.5 | Fixed: 81a0654, migration 0014 |
| 1 | P2 | Enforce provider trust on the ID-token linking path (`apps/server/src/auth/auth.ts:385-391`) | 1.4.4 | Fixed: 35710d5 |
| 1 | P2 | Apply the host-only prefix to OAuth state cookies (`apps/server/src/auth/auth.ts:490-495`) | 3.4.4 | Fixed: 35710d5 |
| 1 | P2 | Disable unused endpoints that export provider credentials (`apps/server/src/auth/auth.ts:68-74`) | 3.2.3 | Fixed: 35710d5 |
| 1 | P3 | Normalize account-existence errors for unverified emails (`apps/server/src/auth/mount.ts:31-35`) | 7.4.1 | Fixed: 35710d5 |
| 2 | P2 | Disable the session-list endpoint that exports device tokens (`apps/server/src/auth/auth.ts:87-92`) | 4.0.3 | Fixed: bdb3a85 |
| 3 | P2 | Normalize HTTPS detection before selecting auth cookie names (`apps/server/src/auth/auth.ts:588-590`) | 4.0.3 | Fixed: fb3c321, d281753 |
| 4 | P2 | Disable provider logout to prevent ID-token export (`apps/server/src/auth/auth.ts:90-92`) | 4.0.3 | Fixed: cf624fd |

## 2. The OAuth 2.1 AS, CIMD and token audiences

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P1 | Make consent rollback atomic across overlapping decisions (`apps/server/src/services/grant-service.ts:1482-1483`) | 4.0.3 | Fixed: 35710d5 |
| 1 | P1 | Bind consent approval to the account shown on the page (`apps/server/src/routes/oauth.ts:144-147`) | 4.0.3 | Fixed: 35710d5 |
| 1 | P2 | Enforce the authorization-details ceiling in the service (`apps/server/src/services/grant-service.ts:1384-1384`) | 4.0.3 | Fixed: 35710d5 |
| 2 | P1 | Verify genuine code issuance before committing consent (`apps/server/src/routes/oauth.ts:196-197`) | 4.0.3 | Fixed: bdb3a85 |
| 2 | P1 | Preserve restrictions applied while consent is pending (`apps/server/src/services/grant-service.ts:1542-1548`) | 4.0.3 | Fixed: bdb3a85 |
| 2 | P2 | Bind each displayed consent to a session-specific decision nonce (`apps/server/src/services/grant-service.ts:276-278`) | 4.0.3 | Fixed: bdb3a85 |
| 2 | P2 | Fail closed when a signed constraint ceiling becomes stale (`apps/server/src/services/grant-service.ts:1443-1444`) | 4.0.3 | Fixed: bdb3a85 |
| 3 | P1 | Bind the issued code to this specific consent attempt (`apps/server/src/services/grant-service.ts:1627-1630`) | 4.0.3 | Fixed: 3957495 |
| 3 | P2 | Restore provider consent after rejecting a staged step-up (`apps/server/src/services/grant-service.ts:1659-1661`) | 4.0.3 | Fixed: 3957495 |
| 4 | P2 | Preserve concurrent scope narrowing when restoring consent (`apps/server/src/services/grant-service.ts:1748-1748`) | 4.0.3 | Fixed: cf624fd |
| 4 | P2 | Restore provider consent when issuance throws (`apps/server/src/services/grant-service.ts:1733-1735`) | 4.0.3 | Fixed: cf624fd |

## 3. Grants and service authorisation

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P1 | Restrict permanent deletion beyond the soft-delete grant (`apps/server/src/services/task-service.ts:1263-1266`) | 4.0.3 | Fixed: 35710d5 |
| 1 | P2 | Require task-write permission when splitting a group (`apps/server/src/services/group-service.ts:133-136`) | 4.0.3 | Fixed: 35710d5 |
| 1 | P2 | Apply organization-wide authorization to implicit tag creation (`apps/server/src/services/tag-service.ts:125-128`) | 4.0.3 | Fixed: 35710d5 |
| 1 | P2 | Remove member emails from grant-authorized responses (`apps/server/src/services/org-service.ts:402-404`) | 4.0.3 | Fixed: 7688261, `/members/resolve` |
| 1 | P2 | Prevent OAuth apps from listing unrelated grants (`apps/server/src/services/grant-service.ts:731-736`) | 4.0.3 | Fixed: 35710d5 |
| 1 | P3 | Build pagination cursors only from authorized records (`apps/server/src/services/task-service.ts:1899-1901`) | 4.0.3 | Fixed: 35710d5 |
| 1 | P3 | Check destination visibility before revealing its group name (`apps/server/src/services/grant-access.ts:220-225`) | 4.0.3 | Fixed: 35710d5 |
| 2 | P2 | Exclude colleague emails from grant-authorized search matching (`apps/server/src/services/search-service.ts:188-193`) | 4.0.3 | Fixed: bdb3a85 |
| 2 | P2 | Bind device approval to the account shown during review (`apps/server/src/services/grant-service.ts:1203-1207`) | 4.0.3 | Fixed: bdb3a85 |
| 2 | P3 | Derive activity cursors only from visible entries (`apps/server/src/services/activity-service.ts:215-217`) | 4.0.3 | Fixed: bdb3a85 |
| 2 | P3 | Check group readability before authorizing group mutations (`apps/server/src/services/group-service.ts:195-196`) | 4.0.3 | Fixed: bdb3a85 |
| 3 | P2 | Authorize every descendant before group deletion and restoration (`apps/server/src/services/group-service.ts:305-307`) | 4.0.3 | Fixed: fb3c321 |
| 3 | P3 | Check group readability before returning an existing create (`apps/server/src/services/group-service.ts:124-127`) | 4.0.3 | Fixed: fb3c321 |
| 3 | P3 | Exclude unreadable subtasks from aggregate counts (`apps/server/src/services/list-access.ts:254-258`) | 4.0.3 | Fixed: fb3c321 |
| 3 | P3 | Redact parent references when the parent is unreadable (`apps/server/src/services/list-access.ts:306-307`) | 4.0.3 | Fixed: fb3c321 |
| 3 | P3 | Hide unreadable group names in constraint-error explanations (`apps/server/src/services/grant-access.ts:672-676`) | 4.0.3 | Fixed: fb3c321 |
| 4 | P2 | Check children's readability before reconciling placements (`apps/server/src/services/grant-access.ts:486-491`) | 4.0.3 | Fixed: cf624fd |
| 4 | P3 | Authorize existing tasks before comparing retry content (`apps/server/src/services/task-service.ts:1535-1539`) | 4.0.3 | Fixed: cf624fd |
| 4 | P3 | Authorize the split task before checking its deletion state (`apps/server/src/services/group-service.ts:145-146`) | 4.0.3 | Fixed: cf624fd |
| 5 | P2 | Authorize the existing parent before duplicating a subtask (`apps/server/src/services/task-service.ts:1564-1564`) | 4.0.3 | Fixed: ce24e98 |
| 5 | P2 | Detach restored group tasks from parents still in Trash (`apps/server/src/services/group-service.ts:410-414`) | 4.0.3 | Fixed: ce24e98 |
| 6 | P2 | Authorize the parent before continuing a subtask series (`apps/server/src/services/recurrence-service.ts:115-123`) | 4.0.3 | Fixed: 9d448d4 |
| 6 | P3 | Re-home restored tasks whose groups remain deleted (`apps/server/src/services/group-service.ts:438-440`) | 4.0.3 | Fixed: 9d448d4 |

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
| 1 | P2 | Bound temporary upload storage before streaming (`apps/server/src/services/attachment-service.ts:128-136`) | 4.0.3 | Fixed: d605269 |
| 1 | P2 | Bind avatar reads to the backend of the current upload (`apps/server/src/services/avatar-service.ts:166-169`) | 4.0.3 | Fixed: d605269 |
| 2 | P2 | Refresh in-flight quota budgets when another upload commits (`apps/server/src/services/attachment-service.ts:146-150`) | 4.0.3 | Fixed: 6a10ac0 |
| 2 | P2 | Bind avatar reads to a specific storage location or generation (`apps/server/src/services/avatar-service.ts:195-196`) | 4.0.3 | Fixed: 6a10ac0 |
| 3 | P2 | Preserve avatar generation uniqueness across removals (`apps/server/src/services/avatar-service.ts:53-54`) | 4.0.3 | Fixed: 8e21242 |
| 4 | P2 | Retain avatar upload slots until storage completes (`apps/server/src/services/avatar-service.ts:113-114`) | 4.0.3 | Fixed: e812ad8 |
| 5 | P2 | Bound DELETE requests waiting on the avatar lock (`apps/server/src/services/avatar-service.ts:108-110`) | 4.0.3 | Fixed: 2c1cd7d |
| 6 | P2 | Close the source file stream after every S3 PUT (`apps/server/src/blob/s3-store.ts:97-103`) | 4.0.3 | Fixed: c5be0e3 |
| 6 | P2 | Keep an idle timeout active throughout S3 response bodies (`apps/server/src/blob/s3-store.ts:57-60`) | 4.0.3 | Accepted: needs the operator's own S3 to stall, and a cut-off would hit slow clients |
| 6 | P2 | Queue uncertain S3 writes for garbage collection (`apps/server/src/services/avatar-service.ts:130-134`) | 4.0.3 | Accepted: a rare lost S3 answer only costs storage |

## 6. Push, mail and outbound SSRF guards

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P2 | Revalidate scheduled deliveries after they leave the queue (`apps/server/src/mail/mail-service.ts:398-399`) | 4.1.3 | Fixed: d605269 |
| 1 | P2 | Apply the delivery limit to each push subscription (`apps/server/src/push/push-service.ts:355-355`) | 11.1.2 | Fixed: d605269 |
| 1 | P3 | Strip SMTP response text before logging delivery errors (`apps/server/src/mail/transport.ts:29-30`) | 7.1.2 | Fixed: d605269 |
| 2 | P2 | Preserve the CIMD deadline until the underlying response closes (`apps/server/src/auth/cimd-fetch.ts:251-255`) | 4.0.3 | Fixed: 6a10ac0 |
| 2 | P2 | Recheck push preferences before each queued notification send (`apps/server/src/push/push-service.ts:348-350`) | 4.0.3 | Fixed: 6a10ac0 |
| 3 | P2 | Bound queued push work as well as concurrent sends (`apps/server/src/push/push-service.ts:342-343`) | 4.0.3 | Fixed: 8e21242 |

## 7. Realtime (SSE) and request middleware

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P1 | Bound chunk allocation in the request-body limiter (`apps/server/src/lib/body-limit.ts:16-18`) | 4.0.3 | Fixed: d605269, 83acd67 |
| 1 | P2 | Bound pending SSE writes and abort stalled transports (`apps/server/src/routes/events.ts:89-92`) | 4.0.3 | Fixed: d605269, 83acd67 |
| 2 | P2 | Destroy evicted SSE sockets even when the frame queue is empty (`apps/server/src/events/sse-transport.ts:98-104`) | 4.0.3 | Fixed: 6a10ac0 |

## 8. The web client

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P1 | Initialize cleanup dependencies before replaying clear messages (`apps/web/src/data/sync/engine.ts:394-394`) | 4.0.3 | Fixed: fd14d42 |
| 1 | P1 | Discard cache restoration results after the startup timeout (`apps/web/src/data/sync/engine.ts:239-240`) | 4.0.3 | Fixed: fd14d42 |
| 2 | P2 | Scope push registration to the session that started it (`apps/web/src/data/push.ts:238-239`) | 4.0.3 | Fixed: cfdc5be |
| 2 | P2 | Invalidate pending pipeline work when the session expires (`apps/web/src/data/sync/engine.ts:549-553`) | 4.0.3 | Fixed: cfdc5be |
| 3 | P2 | Unsubscribe pending push registrations when the session clears (`apps/web/src/data/push.ts:240-244`) | 4.0.3 | Fixed: e377d1f |
| 3 | P2 | Close the pipeline before the final sign-out wipe (`apps/web/src/data/sync/engine.ts:710-715`) | 4.0.3 | Fixed: e377d1f |
| 4 | P2 | Unsubscribe unmarked push registrations on failure (`apps/web/src/data/push.ts:303-304`) | 4.0.3 | Fixed: bdb3a85 |
| 4 | P2 | Extend the sign-out barrier to other tabs' durable writes (`apps/web/src/data/sync/engine.ts:716-718`) | 4.0.3 | Fixed: bdb3a85 |
| 5 | P2 | Remove late cross-tab cache snapshots during sign-out (`apps/web/src/data/sync/engine.ts:671-675`) | 4.0.3 | Fixed: 03dac12 |
| 5 | P2 | Clear secret-bearing mutation results on session expiry (`apps/web/src/data/sync/engine.ts:553-555`) | 4.0.3 | Fixed: 03dac12 |
| 6 | P2 | Remove the old snapshot when /me detects an account switch (`apps/web/src/data/sync/engine.ts:497-498`) | 4.0.3 | Fixed: 572678e |
| 6 | P2 | Make owner-conditional snapshot deletion atomic (`apps/web/src/data/sync/persist.ts:226-229`) | 4.0.3 | Fixed: 572678e |
| 6 | P2 | Sweep late localStorage writes in receiving tabs (`apps/web/src/data/sync/engine.ts:682-685`) | 4.0.3 | Fixed: 572678e |
| 7 | P2 | Fence startup housekeeping against ownership changes (`apps/web/src/data/sync/persist.ts:280-280`) | 4.0.3 | Fixed: 2876932 |
| 7 | P2 | Scope session-expiry cleanup to the ending account (`apps/web/src/data/sync/engine.ts:550-554`) | 4.0.3 | Fixed: 2876932 |
| 8 | P2 | Remember the stored account when expiry follows a restore timeout (`apps/web/src/data/sync/engine.ts:564-564`) | 4.0.3 | Fixed: 9027b7f |
| 8 | P2 | Fence old-tab outbox cleanup before enabling the new account (`apps/web/src/data/sync/engine.ts:503-505`) | 4.0.3 | Fixed: 9027b7f |
| 9 | P2 | Propagate session expiry to other tabs and fence their saves (`apps/web/src/data/sync/engine.ts:569-570`) | 4.0.3 | Fixed: 3138bf9 |
| 10 | P2 | Persist the expiry fence across tabs and reloads (`apps/web/src/data/sync/persist.ts:275-277`) | 4.0.3 | Accepted: a millisecond window before a closing tab processes `expired`; the next online start's 401 deletes the copy |
| 10 | P2 | Keep expired-session edits owned by their original account (`apps/web/src/data/sync/engine.ts:235-235`) | 4.0.3 | Fixed: 982b363 |
| 11 | P2 | Recheck the send gate after pending persistence completes (`apps/web/src/data/sync/engine.ts:235-237`) | 4.0.3 | Fixed: 0a36b33 |
| 12 | P2 | Bound description nesting and recover from parsing failures (`apps/web/src/features/editor/markdown.ts:168-168`) | 4.0.3 | Fixed: ef26837 |
| 13 | P1 | Close the remaining middleware-to-fetch session race (`apps/web/src/data/pipeline/pipeline.ts:773-775`) | — | Refuted: a session ends only on a macrotask (a `/me` response), which can't run between openapi-fetch's awaited middleware and `fetch`; the probe forced a microtask into the gap. At most it is ADR 0051's accepted window. |
| 13 | P2 | Handle parse failures in deferred blur callbacks (`apps/web/src/features/pane/description-field.tsx:122-124`) | — | Fixed: df0e87a |
| 13 | P2 | Synchronize pristine fallback text with incoming descriptions (`apps/web/src/features/pane/description-field.tsx:145-147`) | — | Fixed: df0e87a |
| 13 | P2 | Preserve literal code while bounding container nesting (`apps/web/src/features/editor/markdown.ts:229-231`) | — | Accepted: only code samples nested more than 20 levels deep gain an escape backslash |

## 9. The CLI

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P2 | Parse inline Markdown without pathological backtracking (`apps/cli/src/output/markdown.ts:13-16`) | 4.0.3 | Fixed: b2b415c |
| 1 | P2 | Quote generated Windows commands for a specific shell (`apps/cli/src/mcp-config.ts:200-204`) | 4.0.3 | Fixed: b2b415c |
| 1 | P2 | Clean server-supplied login codes and version strings (`apps/cli/src/commands/auth.ts:207-209`) | 4.0.3 | Fixed: b2b415c |
| 1 | P2 | Validate task reference metadata before rendering it (`apps/cli/src/output/format.ts:144-146`) | 4.0.3 | Fixed: b2b415c |
| 1 | P2 | Reject explicit scope lists that contain no scopes (`apps/cli/src/grant-info.ts:26-28`) | 4.0.3 | Fixed: b2b415c |
| 2 | P2 | Sanitize verbose exception stacks before printing (`apps/cli/src/run.ts:100-101`) | 4.0.3 | Fixed: 9d5fd16, 83acd67 |
| 2 | P2 | Reject malformed credentials without echoing their contents (`apps/cli/src/run.ts:99-99`) | 4.0.3 | Fixed: 9d5fd16, 83acd67 |
| 3 | P2 | Catch and sanitize asynchronous TUI failures (`apps/cli/src/tui/controller.ts:380-383`) | 4.0.3 | Fixed: 8a1f709 |

## 10. Backups, admin, config and the Docker image

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P2 | Keep application files owned by root (`docker/Dockerfile:70-70`) | 4.0.3 | Fixed: d605269 |
| 1 | P2 | Exclude Litestream credentials from the web container (`compose.yaml:9-9`) | 4.0.3 | Fixed: d605269 |
| 1 | P2 | Abort startup when database permission hardening fails (`apps/server/src/db/boot.ts:45-48`) | 4.0.3 | Fixed: d605269 |
| 1 | P2 | Protect the environment file before populating secrets (`docs/operator.md:37-39`) | 4.0.3 | Fixed: d605269 |
| 2 | P2 | Exclude the Litestream credentials file from build contexts (`compose.litestream.yaml:43-43`) | 4.0.3 | Fixed: 6a10ac0 |
| 3 | P2 | Exclude nested runtime data from Docker build contexts (`.dockerignore:14-14`) | 4.0.3 | Fixed: 63c8b8f |

## Structured pass over everything since v1.0.0

| Round | Sev | Finding | ASVS | Outcome |
|---|---|---|---|---|
| 1 | P2 | Prevent preference rollbacks from restoring an expired session (`apps/web/src/data/notifications.ts:249-250`) | — | Fixed: fd14d42 |
| 1 | P2 | Preserve renewal eligibility when rotating push keys (`apps/server/src/push/push-service.ts:300-302`) | — | Fixed: d605269 (supersedes ADR 0040 §4, bullet 3) |
| 1 | P2 | Retain and retry failed push renewals on app open (`apps/web/src/data/push.ts:319-321`) | — | Fixed: fd14d42 |
| 1 | P2 | Apply recurrence patches to the Everyone cache (`packages/core/src/everyone.ts:383-386`) | — | Fixed: fd14d42, 8767d49 |
| 1 | P2 | Include reminder-affecting patches in the detail filter (`apps/web/src/data/task-detail.ts:29-33`) | — | Fixed: fd14d42 |

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

Reviewed commits: 705a3e0 (contract), 719e8fa (server), 1d00b60 (CLI), fad2f0c (web), and the fixes after them.

**Method:**
- **Independent review:** a structured review of every commit, and a focused review per part (server, CLI, web).
- **Audit:** a second, adversarial security review ran over the server, CLI and web commits. Its findings are marked "audit" below.
- **Every fix carries a regression test** that fails without it.

| # | Part | Severity | Finding | Source | Outcome |
|---|---|---|---|---|---|
| 1 | Server | P2 | Revoking a stale `rooster-cli` refresh token ran better-auth's client-wide cleanup and ended every CLI login of the user | structured | Fixed in 7aa8145 |
| 2 | Server | P2 | A CLI admin login refreshing with the `admin` scope it was given got `invalid_scope` | structured | Fixed in 7aa8145 |
| 3 | CLI | P2 | A 200 token response whose body was cut off wasn't retried, so the grace window was missed | structured | Fixed in 52b262a |
| 4 | Web | P2 | A device reconnect sent retained scopes and failed with `422 widening_not_allowed` | structured and focused | Fixed in f19df2f |
| 5 | Web | Medium | `?user_code=` pre-filled the code, so approval was "Enter, then Allow" | audit | Fixed in 1fbb81d (ADR 0066 §13) |
| 6 | Web | Medium | Delete and admin started ticked for `rooster-cli` requests, and anyone can start one | audit | Fixed in 1fbb81d (ADR 0066 §13a) |
| 7 | CLI | Low | Credential POSTs followed redirects; a 307/308 re-sends the body cross-origin | audit | Fixed in 07f5b0a |
| 8 | Server | Low | The `device_connected` notice named the device the CLI reports, which an attacker chooses | audit | Fixed in 861a152 |
| 9 | Server | Low | A third-party app could call itself "rooster CLI" | audit | Fixed in 861a152 |
| 10 | Server | Low | Pending user codes appeared in the request log | audit | Fixed in 861a152 |
| 11 | Server | Low | User codes (40 bits) were hashed with plain SHA-256, crackable from a database copy | audit | Fixed in 861a152 (HMAC with the auth secret) |
| 12 | Server | Low | The per-client limiter stored arbitrary `client_id` strings | audit | Fixed in 861a152 |
| 13 | Server | P2 | `PATCH /me/grants/:id` could add `admin` to an MCP token or `/mcp` login | focused, audit | Fixed in 861a152 |
| 14 | Server | P1 | A refused grace retry (wrong `resource`) revived the old refresh token for good | focused | Fixed in 861a152 |
| 15 | Server | P1 | A revoked, rotated app refresh token stayed redeemable through the grace window | focused | Fixed in 861a152 |
| 16 | Server | P2 | `token=Bearer <rt>` on revoke bypassed the per-grant handling and ran the client-wide cleanup | focused | Fixed in 861a152 |
| 17 | Server | P2 | A new grant with `notifications:read` could mark its own `device_connected` notice as read | focused | Fixed in 861a152 (the notice is browser-only) |
| 18 | CLI | P1 | `mcp header` was bound only to the profile, so a client set up for server A could receive server B's token | focused | Fixed in a797ec3 (`--server`) |
| 19 | CLI | P2 | A 4xx or 429 whose body was cut off counted as a lost refresh and was retried | focused | Fixed in a797ec3 |
| 20 | CLI | P2 | A keychain read-back that failed after a successful write restored the spent refresh token | focused | Fixed in 816cbab |
| 21 | Server | P2 | The grace rollback cleared revocations it hadn't made, reviving an access token that sign-out had revoked | structured | Fixed in b6c23e4 |
| 22 | CLI | P2 | Three or more processes taking over an abandoned lock at once can briefly overlap | Structured and focused | Accepted |
| 23 | CLI | P2 | A live lock holder paused for over 120 s (SIGSTOP, a hung keychain) is taken over by age | Focused | Accepted |


### Accepted risks (Phase 12)
- **Lock takeover races (22, 23).** They need a crashed or paused CLI process, plus concurrent commands at the moment of takeover. The worst case is a revoked grant, so the user logs in again; no credential is exposed. An OS advisory lock would fix it structurally, but Node has none without a native dependency.
- **The refresh grace window (ADR 0066).** A thief who uses a stolen refresh token within 60 s of a rotation, before the real client uses its successor, gets one pair. The theft surfaces as a revoked grant at the real client's next refresh.
- **Device-code phishing in general (ADR 0065).** A user who types a code an attacker started and approves it anyway. Mitigated by the typed code, the warning, the defaults, the browser-only notice and the operator switch.
