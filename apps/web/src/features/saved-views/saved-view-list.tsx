import { inboxOf } from '@rooster/core/reducers';
import { selectSavedView } from '@rooster/core/saved-views';
import type { SavedViewQuery, Task } from '@rooster/core/schemas';
import { useQueryClient } from '@tanstack/react-query';
import { memo, type RefObject, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { myListKey, useListPipeline, useMyList, useMyListStatus } from '../../data/list';
import { useOrgMembers } from '../../data/orgs';
import { syncEngine } from '../../data/sync/engine';
import { useTags } from '../../data/tags';
import type { OrgMember } from '../../data/types';
import { useViewTasks, useViewTasksStatus, viewTasksKey } from '../../data/view-tasks';
import { type Draft, useListStore } from '../../state/list-store';
import { setTags, useTagsStore } from '../../state/tags-store';
import { useViewerDateContext } from '../dates';
import { ListController, type Translate, type ViewModel } from '../list/controller';
import type { Row, RowCache } from '../list/model/rows';
import { draftPlaceholder, ListViewCore, useLivePrefs, useRowElements } from '../list/my-list-view';
import type { PaneControls } from '../pane/pane-controls';
import { type EveryoneSection, memberSectionId } from '../people/everyone-model';
import { buildEveryoneRows } from '../people/everyone-rows';
import { sortMembers } from '../people/members';

/** Whether a view needs its completed matches too (Show completed, or a done/any status). */
export function needsCompleted(query: Pick<SavedViewQuery, 'status'>, showCompleted: boolean) {
  return showCompleted || query.status !== 'open';
}

/**
 * A view's sections on screen (B4): core `selectSavedView` by person, as Everyone's sections.
 * Completed rows still in their completion hold (02 §3.6) keep their place.
 */
export function savedViewSections(
  tasks: readonly Task[],
  query: SavedViewQuery,
  ctx: {
    viewerId: string;
    members: readonly OrgMember[];
    locale: string;
    isPersonal: boolean;
    due: { today: string; nowMs: number; viewerTz: string };
    showCompleted: boolean;
    keep: Readonly<Record<string, unknown>>;
  },
): EveryoneSection[] {
  const holding = Object.keys(ctx.keep).length > 0;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const people = new Map(ctx.members.map((m) => [m.userId, m]));
  return selectSavedView(tasks, query, {
    viewerId: ctx.viewerId,
    due: ctx.due,
    members: ctx.members,
    locale: ctx.locale,
    isPersonal: ctx.isPersonal,
    showCompleted: ctx.showCompleted || holding,
  }).map((section) => ({
    id: memberSectionId(section.assigneeId),
    kind: 'flat',
    date: null,
    taskIds:
      ctx.showCompleted || !holding || query.status !== 'open'
        ? section.taskIds
        : section.taskIds.filter(
            (id) => byId.get(id)?.completedAt === null || Object.hasOwn(ctx.keep, id),
          ),
    assigneeId: section.assigneeId,
    member: section.assigneeId === null ? null : (people.get(section.assigneeId) ?? null),
  }));
}

interface SavedViewRowsProps {
  orgId: string;
  userId: string;
  viewId: string;
  query: SavedViewQuery;
  isPersonal: boolean;
  members: readonly OrgMember[];
  rowsRef: RefObject<readonly Row[]>;
  viewRef: RefObject<ViewModel | null>;
  extraRef: RefObject<Readonly<Record<string, Task>> | null>;
}

/**
 * The rows of a view, subscribed to its cache and the UI store on their own: a keystroke
 * re-renders this component (and only the rows whose model changed), not the layers above
 * (AC-2.12, ADR 0055).
 */
const SavedViewRows = memo(function SavedViewRows({
  orgId,
  userId,
  viewId,
  query,
  isPersonal,
  members,
  rowsRef,
  viewRef,
  extraRef,
}: SavedViewRowsProps) {
  const { i18n } = useTranslation();
  const dateCtx = useViewerDateContext();
  const list = useMyList(orgId);
  const showCompleted = useListStore((s) => s.showCompleted);
  const drafts = useListStore((s) => s.drafts);
  const hiding = useListStore((s) => s.hiding);
  const data = useViewTasks(orgId, viewId, needsCompleted(query, showCompleted)).data;
  const byId = useMemo(
    () => (data ? Object.fromEntries(data.items.map((t) => [t.id, t])) : null),
    [data],
  );
  extraRef.current = byId;
  const sections = useMemo(() => {
    if (!data) return null;
    return savedViewSections(data.items, query, {
      viewerId: userId,
      members,
      locale: i18n.language,
      isPersonal,
      due: { today: dateCtx.today, nowMs: dateCtx.nowMs, viewerTz: dateCtx.timezone },
      showCompleted,
      keep: hiding,
    });
  }, [
    data,
    query,
    userId,
    members,
    i18n.language,
    isPersonal,
    dateCtx.today,
    dateCtx.nowMs,
    dateCtx.timezone,
    showCompleted,
    hiding,
  ]);
  viewRef.current = sections ? { view: 'everyone', sections } : null;
  const rowCache = useRef<RowCache>(new Map());
  const draftTasks = useRef(new Map<string, Task>());
  const rows = useMemo(() => {
    if (!list.data || !sections || !byId) return [];
    const draftTask = (draft: Draft) => {
      let task = draftTasks.current.get(draft.id);
      if (
        !task ||
        task.parentId !== (draft.parentId ?? null) ||
        task.dueDate !== (draft.due?.dueDate ?? null) ||
        task.dueTime !== (draft.due?.dueTime ?? null) ||
        task.startDate !== (draft.due?.startDate ?? null)
      ) {
        task = draftPlaceholder(orgId, userId, draft);
        draftTasks.current.set(draft.id, task);
      }
      return task;
    };
    return buildEveryoneRows(
      sections,
      {
        // My list carries parents for breadcrumbs that are not rows here.
        tasks: { ...list.data.tasks, ...byId },
        drafts,
        draftTask,
        inboxId: inboxOf(list.data)?.id ?? '',
        headers: !isPersonal,
      },
      rowCache.current,
    );
  }, [list.data, sections, byId, drafts, orgId, userId, isPersonal]);
  rowsRef.current = rows;
  return useRowElements(rows);
});

export interface SavedViewListProps {
  orgId: string;
  userId: string;
  viewId: string;
  query: SavedViewQuery;
  /** A personal org: no person sections, no assignment (FR-COL-6). */
  isPersonal: boolean;
  /** Accessible name of the tree grid. */
  label: string;
  pane?: PaneControls | undefined;
}

/**
 * A view's rows (ADR 0073 B4–B6, 02 §10.2): its matches grouped by person like Everyone's tasks
 * (no person headers in a personal org), fully editable through the list controller; each
 * section's add row creates a task with the view's tags for that person.
 */
export function SavedViewList({
  orgId,
  userId,
  viewId,
  query,
  isPersonal,
  label,
  pane,
}: SavedViewListProps) {
  const { t } = useTranslation('list');
  const shared = !isPersonal;
  const showCompleted = useListStore((s) => s.showCompleted);
  const completed = needsCompleted(query, showCompleted);
  const myStatus = useMyListStatus(orgId);
  const rowsStatus = useViewTasksStatus(orgId, viewId, completed);
  const status = {
    ready: myStatus.ready && rowsStatus.ready,
    error: myStatus.error ?? rowsStatus.error,
  };
  const membersData = useOrgMembers(shared ? orgId : undefined).data;
  const members = useMemo(
    () => (shared ? sortMembers(membersData ?? [], userId) : []),
    [shared, membersData, userId],
  );
  const membersRef = useRef(members);
  membersRef.current = members;
  const queryRef = useRef(query);
  queryRef.current = query;
  const pipeline = useListPipeline();
  const queryClient = useQueryClient();
  const dateCtx = useViewerDateContext();
  const dateRef = useRef(dateCtx);
  dateRef.current = dateCtx;
  const rowsRef = useRef<readonly Row[]>([]);
  const viewRef = useRef<ViewModel | null>(null);
  const extraRef = useRef<Readonly<Record<string, Task>> | null>(null);
  const tags = useTags(orgId).data;
  useEffect(() => setTags(tags ?? []), [tags]);
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const prefsRef = useLivePrefs();

  const controller = useMemo(
    () =>
      new ListController({
        orgId,
        userId,
        pipeline,
        t: t as unknown as Translate,
        rows: () => rowsRef.current,
        dateContext: () => dateRef.current,
        prefs: () => prefsRef.current,
        tags: () => Object.values(useTagsStore.getState().byId),
        pane: {
          isOpen: () => Boolean(paneRef.current?.taskId()),
          close: () => paneRef.current?.close(),
        },
        view: () => viewRef.current,
        extraTasks: () => extraRef.current ?? undefined,
        newTaskTags: () => queryRef.current.tags,
        ...(shared ? { members: () => membersRef.current } : {}),
      }),
    [orgId, userId, pipeline, t, shared, prefsRef],
  );

  const refresh = useMemo(
    () => async () => {
      // 02 §13.2: flush the outbox (through the leader tab) and refetch.
      syncEngine()?.syncNow();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: myListKey(orgId) }),
        queryClient.invalidateQueries({ queryKey: viewTasksKey(viewId, completed) }),
      ]);
    },
    [queryClient, orgId, viewId, completed],
  );

  const rowsElement = useMemo(
    () => (
      <SavedViewRows
        orgId={orgId}
        userId={userId}
        viewId={viewId}
        query={query}
        isPersonal={isPersonal}
        members={members}
        rowsRef={rowsRef}
        viewRef={viewRef}
        extraRef={extraRef}
      />
    ),
    [orgId, userId, viewId, query, isPersonal, members],
  );
  const membersFor = useCallback(() => (shared ? members : null), [shared, members]);

  return (
    <ListViewCore
      controller={controller}
      status={status}
      label={label}
      pane={pane}
      shared={shared}
      everyone={shared}
      sorted
      rowsRef={rowsRef}
      rowsElement={rowsElement}
      membersFor={membersFor}
      refresh={refresh}
      canMoveOrg={false}
      resetKey={`view|${orgId}|${viewId}`}
    />
  );
}
