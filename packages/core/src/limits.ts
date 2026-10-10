import type { Prefs } from './schemas/user.ts';

/**
 * Plain constants shared by the schemas and the clients. This module must stay free of zod
 * (and of any schema value import): the web app imports it on its initial route, where the
 * zod runtime would cost ~26 KB gzip (10 §4). `schemas/*` re-export everything here.
 */

export const TASK_TITLE_MAX = 500;
export const GROUP_NAME_MAX = 80;
export const BULK_MAX = 200;
/**
 * P3. Maximum subtask depth (05 §4.3): the number of ancestors a task may have. A top-level
 * task has depth 0, so subtasks nest at most five levels below their root.
 */
export const SUBTASK_DEPTH_MAX = 5;
export const TAG_NAME_MAX = 40;
/** P6. 05 §3 `comment.body`. */
export const COMMENT_BODY_MAX = 20_000;
/**
 * P9. The longest signed authorization query (`oauth_query`) the consent API accepts; the
 * provider's own is a few hundred bytes, plus the client's `state`.
 */
export const OAUTH_QUERY_MAX = 16_384;

/** P10 (FR-REM-1): reminders per user per task, counting fired ones until they are removed. */
export const REMINDERS_MAX = 5;
/** P10. 05 §3 `task_reminder.offset_minutes`: at most four weeks before the due moment. */
export const REMINDER_OFFSET_MAX = 40_320;
/** P10 (FR-REM-3): a reminder missed while the server was down still fires this late. */
export const REMINDER_LATE_MAX_MS = 24 * 60 * 60 * 1000;
/** P10 (FR-ATT-1): the default upload limit; the server's `ROOSTER_UPLOAD_MAX_MB` overrides it. */
export const UPLOAD_MAX_MB_DEFAULT = 25;
/** P10 (06 §2.1): the largest avatar upload. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** P10. Attachment file names are stored as given (cleaned), up to this many characters. */
export const ATTACHMENT_FILENAME_MAX = 255;
/** P10. Live attachments per task. */
export const ATTACHMENTS_PER_TASK_MAX = 100;
/** P10 (FR-REC-1): the longest stored recurrence rule. */
export const RECURRENCE_RULE_MAX = 200;

/**
 * Snippet highlight markers (Unicode private use area). The server wraps every matched term in
 * the snippet with these, so titles that contain brackets or HTML stay unambiguous. Clients
 * split on them; they never appear in stored text.
 */
export const SNIPPET_MARK_START = '\uE000';
export const SNIPPET_MARK_END = '\uE001';

export const SWIPE_ACTIONS = ['complete', 'date', 'move', 'delete', 'none'] as const;

export const DEFAULT_PREFS: Prefs = {
  parseTitleDates: true,
  completeHideMs: 1500,
  swipeLeft: 'date',
  swipeRight: 'complete',
  reminderTime: '08:00',
  allDayReminderTime: '09:00',
  digestTime: '07:00',
  emailMode: 'batch',
};
