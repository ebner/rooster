import type { DueContext, IsoDate } from './dates/index.ts';
import type { Group, Task } from './schemas/index.ts';

/**
 * Smart views (01 FR-VIEW-1, 02 §10, 04 §5.1). Pure selectors shared by the web client (over the
 * cached `ListState`, so views work offline) and the server's `GET /orgs/:id/tasks?view=`.
 *
 * Every smart view covers the open tasks **assigned to the viewer**, subtasks included, and
 * excludes deleted tasks. `ctx.showCompleted` also includes completed ones. Dates are evaluated
 * with the `dates` helpers in the viewer's timezone (floating dates stay strings).
 *
 * CONTRACT (Phase 5 Step 0): the signatures below are fixed; the core agent implements them.
 */

export const SMART_VIEWS = ['today', 'week', 'overdue', 'nodate'] as const;
export type SmartView = (typeof SMART_VIEWS)[number];

/** `ListState` satisfies this; the server builds one from its rows. */
export interface ViewSource {
  groups: Readonly<Record<string, Group>>;
  tasks: Readonly<Record<string, Task>>;
}

export interface ViewContext extends DueContext {
  viewerId: string;
  /** Include completed tasks (the header's "Show completed"). */
  showCompleted: boolean;
}

/**
 * - `overdue`: past due (Today's first section, and the whole Overdue view), due ascending.
 * - `today`: due today (Today's second section).
 * - `day`: one day of Next 7 days; `date` is that day (today … today + 6).
 * - `flat`: the single section of No date (group order, then position, mirroring My tasks).
 */
export type ViewSectionKind = 'overdue' | 'today' | 'day' | 'flat';

export interface ViewSection {
  /** Stable within a view: `overdue`, `today`, `flat`, or the ISO date of a `day`. */
  id: string;
  kind: ViewSectionKind;
  /**
   * The due date a task created inline in this section inherits (02 §3.4): today for `today`,
   * the day for `day`, null for `flat`. Null for `overdue` too: Overdue has no inline add.
   */
  date: IsoDate | null;
  /** Ordered task IDs (top-level tasks and subtasks alike; rows show breadcrumbs). */
  taskIds: readonly string[];
}

export interface ViewCounts {
  /** Open tasks in My tasks (placed tasks; the sidebar's My tasks badge). */
  my: number;
  /** Today's badge: open tasks due today or earlier. */
  today: number;
  week: number;
  /** Shown in the danger tone only when > 0. */
  overdue: number;
  nodate: number;
}

/** Sections for one smart view, in display order. Empty sections are omitted, except `today`. */
export function selectView(
  _source: ViewSource,
  _view: SmartView,
  _ctx: ViewContext,
): ViewSection[] {
  throw new Error('selectView: not implemented (Phase 5, core agent)');
}

/** Sidebar badges for one org; counts ignore `showCompleted` (always open tasks only). */
export function viewCounts(
  _source: ViewSource,
  _ctx: Omit<ViewContext, 'showCompleted'>,
): ViewCounts {
  throw new Error('viewCounts: not implemented (Phase 5, core agent)');
}
