/**
 * The stable `code`s of problem+json responses under `/api/v1` (04 §4.10), with their HTTP
 * status and an example `detail`. The OpenAPI document lists, per operation and status, the
 * codes it can return (routes/common.ts `problems()`), and the contract test checks every
 * real error response against that list.
 */
export const PROBLEM_CODES = {
  unauthenticated: { status: 401, detail: 'Sign in to continue.' },
  forbidden: { status: 403, detail: 'Only owners of this organisation can do that.' },
  csrf_origin: { status: 403, detail: 'Cross-origin request rejected.' },
  forbidden_scope: { status: 403, detail: 'This token lacks the tasks:write capability.' },
  outside_grant: { status: 403, detail: 'This token may only write in the group Prio.' },
  admin_only_scope: {
    status: 403,
    detail: 'Only instance admins can grant the "admin" permission.',
  },
  invite_email_mismatch: {
    status: 403,
    detail: 'This invite was sent to a different email address.',
  },
  not_found: { status: 404, detail: 'Task not found.' },
  id_conflict: { status: 409, detail: 'That ID is already in use.' },
  already_exists: { status: 409, detail: 'That entry is already on the allowlist.' },
  already_member: { status: 409, detail: 'That person is already a member.' },
  cannot_disable_self: { status: 409, detail: 'You cannot deactivate your own account.' },
  inbox_immutable: { status: 409, detail: 'The Inbox cannot be renamed, moved or deleted.' },
  last_group: { status: 409, detail: 'Keep at least one group besides the Inbox.' },
  group_not_empty: {
    status: 409,
    detail: 'The group has tasks: choose moveTasksTo or deleteTasks.',
  },
  last_owner: { status: 409, detail: 'An organisation needs at least one owner.' },
  last_identity: {
    status: 409,
    detail: 'This is your only way to sign in; link another identity before removing it.',
  },
  not_in_trash: { status: 409, detail: 'Only deleted tasks can be deleted permanently.' },
  not_subtask: { status: 409, detail: 'Only subtasks can be reordered among siblings.' },
  personal_org: {
    status: 409,
    detail: 'The personal organisation cannot be shared or changed.',
  },
  slug_taken: { status: 409, detail: 'Slug in use.' },
  idempotency_stale: {
    status: 409,
    detail:
      'The token’s access changed since this request was first sent; retry with a new Idempotency-Key.',
  },
  token_shown_once: {
    status: 409,
    detail: 'The token was already shown once and cannot be shown again; create another one.',
  },
  ambiguous_ref: {
    status: 409,
    detail: 'The ref 0192f3a0 matches more than one task; use more characters.',
  },
  tag_name_taken: {
    status: 409,
    detail: 'A tag with that name already exists in this organisation.',
  },
  too_many_reminders: { status: 409, detail: 'A task can have at most 5 reminders.' },
  push_keys_from_env: {
    status: 409,
    detail: 'The VAPID keys come from the environment and cannot be replaced here.',
  },
  // P10 (files): attachments and calendar feeds.
  too_many_attachments: { status: 409, detail: 'A task can have at most 100 attachments.' },
  too_many_ical_feeds: {
    status: 409,
    detail: 'You can have at most 10 calendar feeds; revoke one first.',
  },
  mime_mismatch: {
    status: 415,
    detail: 'The file is not the image its name or type claims; nothing was uploaded.',
  },
  conflict_deleted: { status: 410, detail: 'The task is deleted; restore it first.' },
  invite_invalid: { status: 410, detail: 'This invite can no longer be used (expired).' },
  push_gone: { status: 410, detail: 'This device is no longer subscribed; subscribe again.' },
  payload_too_large: { status: 413, detail: 'The request body exceeds the limit of 1024 KB.' },
  unsupported_media_type: { status: 415, detail: 'Send JSON (application/json).' },
  validation_failed: { status: 422, detail: 'The request did not pass validation.' },
  idempotency_key_reuse: {
    status: 422,
    detail: 'This Idempotency-Key was already used for a different request.',
  },
  invalid_parent: {
    status: 422,
    detail: 'A subtask must be in the same organisation as its parent.',
  },
  subtask_cycle: {
    status: 422,
    detail: 'A task cannot become a subtask of itself or of its own subtasks.',
  },
  subtask_depth: { status: 422, detail: 'Subtasks can be nested at most 5 levels deep.' },
  widening_not_allowed: {
    status: 422,
    detail: "An app's access can only be narrowed here; reconnect the app to widen it.",
  },
  nothing_approved: {
    status: 422,
    detail: 'Choose at least one thing the app may do, or deny it.',
  },
  confirm_name_mismatch: {
    status: 422,
    detail: 'Type the organisation name exactly to delete it.',
  },
  not_recurring: { status: 422, detail: 'The task does not repeat.' },
  reminder_needs_due: {
    status: 422,
    detail: 'A reminder before the due date needs a due date.',
  },
  reminder_in_past: { status: 422, detail: 'The reminder time has already passed.' },
  rate_limited: { status: 429, detail: 'Too many requests; slow down.' },
  push_failed: { status: 502, detail: 'The push service did not accept the message.' },
  unavailable: { status: 503, detail: 'The server is shutting down; reconnect shortly.' },
} as const satisfies Record<string, { status: number; detail: string }>;

export type ProblemCode = keyof typeof PROBLEM_CODES;

/**
 * Codes every operation that declares the status can return. `csrf_origin` and
 * `idempotency_key_reuse` apply to unsafe methods only; the document builder drops them from
 * GET operations (lib/openapi.ts).
 */
export const GENERIC_CODES: Partial<Record<number, ProblemCode[]>> = {
  401: ['unauthenticated'],
  403: ['forbidden_scope', 'outside_grant', 'csrf_origin'],
  404: ['not_found'],
  413: ['payload_too_large'],
  415: ['unsupported_media_type'],
  422: ['validation_failed', 'idempotency_key_reuse'],
  429: ['rate_limited'],
  503: ['unavailable'],
};

/** Codes that only an unsafe (cookie-authenticated or keyed) request can produce. */
export const UNSAFE_ONLY_CODES: ReadonlySet<ProblemCode> = new Set([
  'csrf_origin',
  'idempotency_key_reuse',
]);

export function isProblemCode(code: string): code is ProblemCode {
  return Object.hasOwn(PROBLEM_CODES, code);
}
