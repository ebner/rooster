import type { DueContext } from '@rooster/core/dates';
import { compareKeys } from '@rooster/core/ordering';
import { isProjectView, type SavedViewSection, selectSavedView } from '@rooster/core/saved-views';
import type { Task as CoreTask } from '@rooster/core/schemas/list';
import { type SavedViewQuery, savedViewQuerySchema } from '@rooster/core/schemas/views';
import {
  RoosterApiError,
  type RoosterClient,
  type SavedView,
  type SavedViewTasks,
  unwrap,
} from './api.ts';
import { count } from './output/format.ts';

/**
 * Phase 13 (ADR 0073 B): an org's views (saved queries) for `rooster view ls`, `rooster ls
 * --view` and the TUI's view bar. The rows come from `GET /views/:id/tasks` and are grouped by
 * person with core `selectSavedView`, exactly as the web groups them (B4), so every client
 * lists the same rows in the same order (AC-13.5).
 */

export type { SavedView, SavedViewTasks };

/**
 * What a view's rows are filtered by when its stored query can't be read (the response is only
 * type-cast): every row the server sent, by person. The server already applied the real query.
 */
const SERVER_ROWS: SavedViewQuery = {
  tags: [],
  tagMode: 'any',
  assignee: 'anyone',
  due: 'any',
  status: 'any',
};

/** The view's query as the API promises it, or `SERVER_ROWS`. */
export function viewQuery(view: Pick<SavedView, 'query'>): SavedViewQuery {
  const parsed = savedViewQuerySchema.safeParse(view.query);
  return parsed.success ? parsed.data : SERVER_ROWS;
}

/** A project view: exactly one tag (B3). Shown as `#`, other views as `⌕` (B9). */
export function viewIcon(view: Pick<SavedView, 'query'>): '#' | '⌕' {
  return isProjectView(viewQuery(view)) ? '#' : '⌕';
}

/** The views in the member's own order (the server's order; sorted again since it is cast). */
export function inMyOrder<T extends Pick<SavedView, 'position' | 'id'>>(views: readonly T[]): T[] {
  return [...views].sort(
    (a, b) => compareKeys(String(a.position), String(b.position)) || compareKeys(a.id, b.id),
  );
}

/**
 * `GET /orgs/:orgId/views` (live, or the archived ones). A server without views (`404` from a
 * version before Phase 13) has none; any other failure is the caller's.
 */
export async function fetchViews(
  api: RoosterClient,
  orgId: string,
  options: { archived?: boolean; missingIsEmpty?: boolean } = {},
): Promise<SavedView[]> {
  try {
    const views = await unwrap(
      api.GET('/api/v1/orgs/{orgId}/views', {
        params: { path: { orgId }, query: options.archived === true ? { archived: 'true' } : {} },
      }),
    );
    return inMyOrder(views);
  } catch (error) {
    // The org is one of mine (from `/me`): a 404 is a server from before Phase 13.
    if (options.missingIsEmpty === true && error instanceof RoosterApiError && error.status === 404)
      return [];
    throw error;
  }
}

/** `GET /views/:id/tasks`: every matching task (`completed=true` adds completed ones). */
export async function fetchViewTasks(
  api: RoosterClient,
  viewId: string,
  completed: boolean,
): Promise<SavedViewTasks> {
  return unwrap(
    api.GET('/api/v1/views/{id}/tasks', {
      params: { path: { id: viewId }, query: completed ? { completed: 'true' } : {} },
    }),
  );
}

/** The header's "7 open · 12 done", from validated counts; null when they aren't numbers. */
export function viewCounts(result: Pick<SavedViewTasks, 'counts'>) {
  const open = count(result.counts?.open);
  const done = count(result.counts?.done);
  return open === null || done === null ? null : { open, done };
}

export interface ViewSectionsInput {
  view: Pick<SavedView, 'query'>;
  /** The API's tasks or the TUI's (the same DTO, typed by the API client or by core). */
  tasks: Iterable<CoreTask>;
  viewerId: string;
  due: DueContext;
  members: readonly { userId: string; name: string }[];
  locale: string;
  isPersonal: boolean;
  showCompleted: boolean;
}

/** The view's sections by person (B4): core `selectSavedView`, the web's own grouping. */
export function viewSections(input: ViewSectionsInput): SavedViewSection[] {
  return selectSavedView(input.tasks, viewQuery(input.view), {
    viewerId: input.viewerId,
    due: input.due,
    members: input.members.map((m) => ({ userId: m.userId, name: m.name })),
    locale: input.locale,
    isPersonal: input.isPersonal,
    showCompleted: input.showCompleted,
  });
}
