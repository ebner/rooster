import { RoosterApiError, type RoosterClient, type Schemas, unwrap } from '@rooster/api-client';
import { compareKeys } from '@rooster/core/ordering';
import { isProjectView, selectSavedView } from '@rooster/core/saved-views';
import { type SavedViewQuery, savedViewQuerySchema } from '@rooster/core/schemas/views';
import { type CallContext, type Org, type Task, ToolError } from './context.ts';
import { canonical } from './format.ts';

/**
 * Phase 13 (ADR 0073 B12): `list_views` and `list_tasks {view}` with one of an org's views
 * (saved queries). The rows come from `GET /views/:id/tasks`, grouped with core
 * `selectSavedView` as the web groups them (me, the members alphabetically, then Unassigned;
 * each by due date), so an agent reads the same rows in the same order as the user (AC-13.5).
 */

export type SavedView = Schemas['SavedView'];

/** A query the response doesn't hold as promised: every row the server sent, by person. */
const SERVER_ROWS: SavedViewQuery = {
  tags: [],
  tagMode: 'any',
  assignee: 'anyone',
  due: 'any',
  status: 'any',
};

export function viewQuery(view: Pick<SavedView, 'query'>): SavedViewQuery {
  const parsed = savedViewQuerySchema.safeParse(view.query);
  return parsed.success ? parsed.data : SERVER_ROWS;
}

/** An org's views in the user's own order (live, or the archived ones). */
export async function listViews(
  client: RoosterClient,
  orgId: string,
  archived = false,
): Promise<SavedView[]> {
  const views = await unwrap(
    client.GET('/api/v1/orgs/{orgId}/views', {
      params: { path: { orgId }, query: archived ? { archived: 'true' } : {} },
    }),
  );
  return [...views].sort(
    (a, b) => compareKeys(String(a.position), String(b.position)) || compareKeys(a.id, b.id),
  );
}

/** The compact form `list_views` returns (user content: framed as data by the caller). */
export function viewEntry(view: SavedView): Record<string, unknown> {
  const project = isProjectView(viewQuery(view));
  return {
    id: view.id,
    name: view.name,
    ...(project ? { project: true } : {}),
    shared: view.shared === true,
    open: canonical.count(view.openCount) ?? 0,
    ...(view.archivedAt === null ? {} : { archived: true }),
  };
}

/**
 * The view `ref` names in `org`: its ID (an archived one too), else its name in any case among
 * the live views (`#juniper` also finds "juniper"). Several of one name ask for the ID.
 */
export async function resolveView(ctx: CallContext, org: Org, ref: string): Promise<SavedView> {
  const live = await listViews(ctx.client, org.id);
  const wanted = ref.trim();
  const byId = live.find((view) => view.id === wanted);
  if (byId !== undefined) return byId;
  const named = (text: string) =>
    live.filter((view) => view.name.toLocaleLowerCase() === text.toLocaleLowerCase());
  let matches = named(wanted);
  if (matches.length === 0 && wanted.startsWith('#')) matches = named(wanted.slice(1));
  const [only] = matches;
  if (only !== undefined && matches.length === 1) return only;
  if (matches.length > 1) {
    throw new ToolError('Several views have that name; pass the id of the one you mean.', {
      views: matches.map(viewEntry),
    });
  }
  const archived = await listViews(ctx.client, org.id, true).catch((error: unknown) => {
    if (error instanceof RoosterApiError && error.status === 404) return [];
    throw error;
  });
  const old = archived.find((view) => view.id === wanted);
  if (old !== undefined) return old;
  throw new ToolError(
    'No list or view has that name. The lists are my, today, week, overdue, nodate and everyone; list_views shows the organisation’s views.',
    { view: wanted, views: live.map((view) => view.name) },
  );
}

/** A view's rows in display order, with the "7 open · 12 done" counts. */
export async function savedViewRows(
  ctx: CallContext,
  org: Org,
  view: SavedView,
  includeCompleted: boolean,
): Promise<{ tasks: Task[]; counts: { open: number; done: number } | null }> {
  const result = await unwrap(
    ctx.client.GET('/api/v1/views/{id}/tasks', {
      params: { path: { id: view.id }, query: includeCompleted ? { completed: 'true' } : {} },
    }),
  );
  const me = await ctx.me();
  const { today, timezone } = await ctx.today();
  const members = org.isPersonal ? [] : await ctx.members(org.id);
  const sections = selectSavedView(result.items, viewQuery(view), {
    viewerId: me.id,
    due: { today, nowMs: ctx.now(), viewerTz: timezone },
    members: members.map((m) => ({ userId: m.userId, name: m.name })),
    locale: me.locale,
    isPersonal: org.isPersonal,
    showCompleted: includeCompleted,
  });
  const byId = new Map(result.items.map((task) => [task.id, task]));
  const tasks = sections.flatMap((section) =>
    section.taskIds.map((id) => byId.get(id)).filter((task): task is Task => task !== undefined),
  );
  const open = canonical.count(result.counts?.open);
  const done = canonical.count(result.counts?.done);
  return { tasks, counts: open === null || done === null ? null : { open, done } };
}
