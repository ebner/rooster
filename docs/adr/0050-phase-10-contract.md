# ADR 0050: Phase 10 contract

- Status: accepted
- Date: 2026-10-10
- Builds on: ADR 0049

## Contract (committed before implementation starts)
- **Core schemas** (`packages/core/src/schemas`):
  - `list.ts`: `recurrenceRuleSchema` and `recurrenceBasisSchema`.
    - `TaskDTO` gains `recurrence`, `recurrenceBasis` and `nextReminderAt`. They are optional so that persisted caches still parse, but the server always sends them.
    - The due unit gains `recurrence` and `recurrenceBasis`. Create takes `reminders`; PATCH takes `reminders` and `clearReminders`.
    - `taskComplete.nextId`, `taskSkip` / `taskSkipResult`, and `taskDetail.attachments` and `.reminders`.
  - New files: `reminders.ts`, `attachments.ts` and `ical.ts`.
  - The `reminder` notification type, with data `reminderId`, `fireAt` and `late`.
  - `prefs.allDayReminderTime`, defaulting to 09:00.
  - The unsubscribe category `reminder`.
- **Core modules:**
  - `recurrence.ts`: `parseRule`, `formatRule` and `isValidRule` are done; `normalizeRule`, `nextOccurrence` and `nextInstance` are stubs.
  - `reminders.ts`: `dueMoment`, `resolveFireAt`, `parseReminderOffset` and `formatReminderOffset`, all done.
  - `dates/tokens.ts`: the `findReminderTokens` stub.
  - `DateParseResult.recurrence`.
  - `limits.ts` gets the P10 limits.
  - The notification preference matrix gains the `reminder` row.
- **Server:**
  - Migration `0011_p10_reminders_attachments_ical`: `task_reminder`, `attachment`, `ical_feed`, `blob_gc` with its `attachment_blob_gc` trigger, `user.avatar_at` and `user.oidc_image`, and the `task_series_open` index.
  - Drizzle tables in `db/schema/p10.ts`.
  - `services/attachment-queries.ts`, with `attachmentCounts` and `attachmentsForTask` for the task DTOs.
  - OpenAPI examples for every new component in `lib/openapi-examples.ts`. Each route file registers its components with `named()`.
  - Marked insertion points in `services/index.ts`, `jobs/register.ts` and `test/authz.matrix.test.ts`.
- **Dependencies:**
  - `sharp`, `file-type`, `busboy`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, plus `@types/busboy` and `ical.js` for tests.
  - sharp is a native dependency: it is listed in `NATIVE_DEPS` and installed in the Dockerfile's runtime `node_modules`.
- **Web:**
  - The `AttachmentsSection` slot in the detail pane (`features/attachments/attachments-section.tsx`).
  - The i18n namespaces `attachments` and `calendar`.

## API surface (06)
| Route | Owner |
|---|---|
| `POST /tasks/:id/complete {completed, nextId?}` → `{task, next?}` | server-tasks |
| `POST /tasks/:id/skip {nextId?}` → `{next}` | server-tasks |
| `POST /tasks/:id/reminders` (`ReminderCreate`) → `Reminder` (201; 200 for an identical one) · `DELETE /tasks/:id/reminders/:reminderId` → 204 | server-tasks |
| Task create and PATCH `reminders`, `clearReminders`, `recurrence`, `recurrenceBasis`; `parse: true` reads recurrence phrases and `!` tokens | server-tasks |
| `POST /tasks/:id/attachments` (multipart `file`) → `Attachment` 201 · `GET /attachments/:id[?inline=1]` · `GET /attachments/:id/thumb` · `DELETE /attachments/:id` | server-files |
| `PUT /me/avatar` (multipart `file`) → `Me` · `DELETE /me/avatar` → `Me` · `GET /avatars/:userId` | server-files |
| `GET/POST /me/ical-feeds` · `DELETE /me/ical-feeds/:id` · `GET /ical/:token.ics` (outside `/api/v1`) | server-files |

