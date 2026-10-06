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
  digestTime: '07:00',
};
