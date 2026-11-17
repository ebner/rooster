import type { ListState } from '@rooster/core/reducers';
import type { Tag } from '@rooster/core/schemas';
import {
  type AllView,
  type AllViewSection,
  type AllViewSource,
  selectAllView,
  type ViewContext,
} from '@rooster/core/views';
import { type QueryObserverResult, useQueries } from '@tanstack/react-query';
import { useMemo, useRef, useSyncExternalStore } from 'react';
import { api, unwrap } from './http';
import { useListPipeline } from './list';
import { toMember } from './mappers';
import { myListKey, tagsKey } from './pipeline/pipeline';
import { queryKeys } from './query-keys';
import { withPendingTags } from './tags';
import type { OrgMember } from './types';

/**
 * Phase 13 (ADR 0073 A9): All organisations is computed on the client from the per-org
 * `['my-list', orgId]` caches the sync engine prefetches for every org (so it works offline);
 * there is no server call of its own.
 */

/** The same array while every element is the same: memo deps stay put across renders. */
function useStableArray<T>(items: readonly T[]): readonly T[] {
  const ref = useRef(items);
  const prev = ref.current;
  if (prev.length !== items.length || items.some((item, i) => item !== prev[i])) {
    ref.current = items;
  }
  return ref.current;
}

export interface OrgLists {
  /** Each org's optimistic list, in the order asked for (undefined until loaded). */
  states: readonly (ListState | undefined)[];
  /** Every list has loaded or failed, and at least one loaded. */
  ready: boolean;
  /** Set when every list failed. */
  error: Error | null;
}

/**
 * A list that has loaded or failed, or that can't load now: a query paused offline without a
 * cached list counts as an empty org, so one never-cached org doesn't hold up the rest.
 */
export function listSettled(result: Pick<QueryObserverResult, 'data' | 'isError' | 'fetchStatus'>) {
  return result.data !== undefined || result.isError || result.fetchStatus === 'paused';
}

export function combineLists(results: QueryObserverResult<ListState>[]) {
  return {
    states: results.map((r) => r.data),
    settled: results.every(listSettled),
    error: results.length > 0 && results.every((r) => r.isError) ? results[0]?.error : null,
  };
}

/** Every org's My tasks list (`['my-list', orgId]`), in `orgIds` order. */
export function useOrgLists(orgIds: readonly string[]): OrgLists {
  const pipeline = useListPipeline();
  const combined = useQueries({
    queries: orgIds.map((orgId) => ({
      queryKey: myListKey(orgId),
      queryFn: () => pipeline.fetch(orgId),
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    })),
    combine: combineLists,
  });
  const states = useStableArray(combined.states);
  const loaded = states.some((s) => s !== undefined);
  return {
    states,
    ready: combined.settled && loaded,
    error: loaded ? null : (combined.error ?? null),
  };
}

/** The sources `selectAllView` takes, from the lists in sidebar order. */
export function allViewSources(
  orgIds: readonly string[],
  states: readonly (ListState | undefined)[],
): AllViewSource[] {
  return orgIds.flatMap((orgId, i) => {
    const source = states[i];
    return source ? [{ orgId, source }] : [];
  });
}

/**
 * The orgs' lists as one state (tasks and groups by id, which are unique across orgs), for the
 * row model and the list's commands. `orgOf` maps every task (live or deleted) and group to
 * its org.
 */
export interface MergedLists {
  state: ListState;
  orgOfTask: ReadonlyMap<string, string>;
  orgOfGroup: ReadonlyMap<string, string>;
}

export function mergeOrgLists(
  orgIds: readonly string[],
  states: readonly (ListState | undefined)[],
): MergedLists {
  const tasks: Record<string, ListState['tasks'][string]> = {};
  const groups: Record<string, ListState['groups'][string]> = {};
  const deletedTasks: Record<string, ListState['deletedTasks'][string]> = {};
  const deletedGroups: Record<string, ListState['deletedGroups'][string]> = {};
  const expanded: string[] = [];
  const orgOfTask = new Map<string, string>();
  const orgOfGroup = new Map<string, string>();
  let serverTime = 0;
  orgIds.forEach((orgId, i) => {
    const state = states[i];
    if (!state) return;
    Object.assign(tasks, state.tasks);
    Object.assign(groups, state.groups);
    Object.assign(deletedTasks, state.deletedTasks);
    Object.assign(deletedGroups, state.deletedGroups);
    expanded.push(...state.expandedTaskIds);
    for (const id of Object.keys(state.tasks)) orgOfTask.set(id, orgId);
    for (const id of Object.keys(state.deletedTasks)) orgOfTask.set(id, orgId);
    for (const id of Object.keys(state.groups)) orgOfGroup.set(id, orgId);
    serverTime = Math.max(serverTime, state.serverTime);
  });
  return {
    state: {
      orgId: '',
      groups,
      tasks,
      deletedTasks,
      deletedGroups,
      expandedTaskIds: expanded,
      serverTime,
    },
    orgOfTask,
    orgOfGroup,
  };
}

export interface AllViewData {
  /** The view's sections across every org (core `selectAllView`); null until loaded. */
  sections: readonly AllViewSection[] | null;
  merged: MergedLists | null;
}

/**
 * One All organisations view (ADR 0073 A2): the date sections mixed across `orgIds` (sidebar
 * order) and the merged lists. Recomputed only when one org's list, the view or the clock
 * changes.
 */
export function useAllView(
  orgIds: readonly string[],
  view: AllView,
  ctx: ViewContext | null,
): AllViewData & Pick<OrgLists, 'ready' | 'error'> {
  const ids = useStableArray(orgIds);
  const { states, ready, error } = useOrgLists(ids);
  const merged = useMemo(
    () => (states.some((s) => s !== undefined) ? mergeOrgLists(ids, states) : null),
    [ids, states],
  );
  const sections = useMemo(
    () => (ctx && merged ? selectAllView(allViewSources(ids, states), view, ctx) : null),
    [ids, states, view, ctx, merged],
  );
  return { sections, merged, ready, error };
}

/** A stable key of the queued `tag.create` ops of `orgIds` ('' when there are none). */
function pendingTagsKey(
  pipeline: ReturnType<typeof useListPipeline>,
  orgIds: readonly string[],
): string {
  let key = '';
  for (const orgId of orgIds) {
    for (const op of pipeline.pendingOps(orgId)) if (op.kind === 'tag.create') key += op.entityId;
  }
  return key;
}

/** Every org's tags (each carries its `orgId`), with the tags of queued creations. */
export function useOrgsTags(orgIds: readonly string[]): readonly Tag[] {
  const pipeline = useListPipeline();
  const ids = useStableArray(orgIds);
  const lists = useQueries({
    queries: ids.map((orgId) => ({
      queryKey: tagsKey(orgId),
      queryFn: () => pipeline.transport.fetchTags(orgId),
      staleTime: 60_000,
    })),
  });
  const data = useStableArray(lists.map((q) => q.data as readonly Tag[] | undefined));
  const pendingKey = useSyncExternalStore(pipeline.subscribe, () => pendingTagsKey(pipeline, ids));
  return useMemo(
    () =>
      ids.flatMap((orgId, i) => [
        ...(pendingKey === ''
          ? (data[i] ?? [])
          : withPendingTags(data[i] ?? [], pipeline.pendingOps(orgId), orgId)),
      ]),
    [ids, data, pendingKey, pipeline],
  );
}

/** The members of each shared org (`['org-members', orgId]`), by org. */
export function useOrgsMembers(orgIds: readonly string[]): ReadonlyMap<string, OrgMember[]> {
  const ids = useStableArray(orgIds);
  const lists = useQueries({
    queries: ids.map((orgId) => ({
      queryKey: queryKeys.orgMembers(orgId),
      queryFn: async () =>
        (
          await unwrap(api.GET('/api/v1/orgs/{orgId}/members', { params: { path: { orgId } } }))
        ).map(toMember),
    })),
  });
  const data = useStableArray(lists.map((q) => q.data as OrgMember[] | undefined));
  return useMemo(
    () => new Map(ids.flatMap((orgId, i) => (data[i] ? [[orgId, data[i]] as const] : []))),
    [ids, data],
  );
}

export function combineStatus(results: QueryObserverResult<unknown>[]) {
  const loaded = results.some((r) => r.data !== undefined);
  return {
    ready: loaded && results.every(listSettled),
    error:
      !loaded && results.length > 0 && results.every((r) => r.isError)
        ? (results[0]?.error ?? null)
        : null,
  };
}

/**
 * Whether the orgs' lists have loaded (or failed), without subscribing to the data: the All
 * view's frame re-renders on status changes only, as an org's own list does.
 */
export function useOrgListsStatus(orgIds: readonly string[]): {
  ready: boolean;
  error: Error | null;
} {
  const pipeline = useListPipeline();
  const status = useQueries({
    queries: orgIds.map((orgId) => ({
      queryKey: myListKey(orgId),
      queryFn: () => pipeline.fetch(orgId),
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      select: () => true,
    })),
    combine: combineStatus,
  });
  const { ready, error } = status;
  return useMemo(() => ({ ready, error }), [ready, error]);
}

/**
 * The org whose list holds `taskId` (the detail pane over All organisations): its id, undefined
 * while the lists load, or null when none of them has it.
 */
export function useTaskOrg(
  orgIds: readonly string[],
  taskId: string | null,
): string | null | undefined {
  const pipeline = useListPipeline();
  // A boolean per org, not the lists: the screen re-renders only when the answer changes.
  const found = useQueries({
    queries: orgIds.map((orgId) => ({
      queryKey: myListKey(orgId),
      queryFn: () => pipeline.fetch(orgId),
      staleTime: 30_000,
      select: (state: ListState) => (taskId ? taskId in state.tasks : false),
    })),
    combine: (results) => ({
      index: results.findIndex((r) => r.data === true),
      settled: results.every(listSettled),
    }),
  });
  if (!taskId) return null;
  if (found.index >= 0) return orgIds[found.index];
  return found.settled ? null : undefined;
}
