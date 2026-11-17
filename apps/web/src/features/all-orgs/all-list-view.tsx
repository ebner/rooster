import type { Task } from '@rooster/core/schemas';
import type { AllView, ViewContext, ViewSection } from '@rooster/core/views';
import { useQueryClient } from '@tanstack/react-query';
import { memo, type RefObject, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAllView, useOrgListsStatus, useOrgsMembers, useOrgsTags } from '../../data/all-views';
import { myListKey, useListPipeline } from '../../data/list';
import { syncEngine } from '../../data/sync/engine';
import type { Org, OrgMember } from '../../data/types';
import { type Draft, useListStore } from '../../state/list-store';
import { setTags, useTagsStore } from '../../state/tags-store';
import { useViewerDateContext } from '../dates';
import { ListController, type Translate, type ViewModel } from '../list/controller';
import type { Row, RowCache } from '../list/model/rows';
import { buildViewRows } from '../list/model/view-rows';
import { draftPlaceholder, ListViewCore, useLivePrefs, useRowElements } from '../list/my-list-view';
import type { PaneControls } from '../pane/pane-controls';
import { sortMembers } from '../people/members';
import { AllListController, type AllOrgScope } from './all-controller';

interface AllRowsProps {
  orgIds: readonly string[];
  userId: string;
  view: AllView;
  rowsRef: RefObject<readonly Row[]>;
  viewRef: RefObject<ViewModel | null>;
  defaultOrgId: string;
}

/**
 * The rows of an All organisations view, subscribed to every org's list and the UI store on
 * their own: a keystroke or one org's change re-renders this component (and only the rows
 * whose model changed), not the layers above (AC-2.12, ADR 0055).
 */
const AllRows = memo(function AllRows({
  orgIds,
  userId,
  view,
  rowsRef,
  viewRef,
  defaultOrgId,
}: AllRowsProps) {
  const dateCtx = useViewerDateContext();
  const drafts = useListStore((s) => s.drafts);
  const showCompleted = useListStore((s) => s.showCompleted);
  const hiding = useListStore((s) => s.hiding);
  // Rows still in their completion hold stay in place: completed tasks keep their section.
  const holding = Object.keys(hiding).length > 0;
  const ctx = useMemo<ViewContext>(
    () => ({
      viewerId: userId,
      showCompleted: showCompleted || holding,
      today: dateCtx.today,
      nowMs: dateCtx.nowMs,
      viewerTz: dateCtx.timezone,
    }),
    [userId, showCompleted, holding, dateCtx.today, dateCtx.nowMs, dateCtx.timezone],
  );
  const { sections, merged } = useAllView(orgIds, view, ctx);
  const viewSections = useMemo<ViewSection[] | null>(
    () =>
      sections?.map((section) => ({
        id: section.id,
        kind: section.kind,
        date: section.date,
        taskIds: section.items.map((item) => item.taskId),
      })) ?? null,
    [sections],
  );
  viewRef.current = viewSections ? { view, sections: viewSections } : null;
  const rowCache = useRef<RowCache>(new Map());
  const draftTasks = useRef(new Map<string, Task>());
  const rows = useMemo(() => {
    if (!merged || !viewSections) return [];
    const draftTask = (draft: Draft) => {
      let task = draftTasks.current.get(draft.id);
      if (
        !task ||
        task.parentId !== (draft.parentId ?? null) ||
        task.dueDate !== (draft.due?.dueDate ?? null) ||
        task.dueTime !== (draft.due?.dueTime ?? null) ||
        task.startDate !== (draft.due?.startDate ?? null)
      ) {
        task = draftPlaceholder(defaultOrgId, userId, draft);
        draftTasks.current.set(draft.id, task);
      }
      return task;
    };
    return buildViewRows(
      merged.state,
      viewSections,
      {
        view,
        drafts,
        showCompleted,
        hiding,
        draftTask,
        orgOf: (taskId) => merged.orgOfTask.get(taskId),
      },
      rowCache.current,
    );
  }, [merged, viewSections, view, drafts, showCompleted, hiding, defaultOrgId, userId]);
  rowsRef.current = rows;
  return useRowElements(rows);
});

export interface AllListViewProps {
  /** The viewer's orgs, in sidebar order. */
  orgs: readonly Org[];
  userId: string;
  /** Where a new task goes without a `^org` token (ADR 0073 A4). */
  defaultOrgId: string;
  view: AllView;
  /** Accessible name of the tree grid. */
  label: string;
  pane?: PaneControls | undefined;
}

/**
 * All organisations (ADR 0073 A, 02 §10.1): Today, Next 7 days or Overdue over every org,
 * computed from the orgs' cached lists. The list is the smart views' (keys, selection, the
 * bulk bar, the phone chrome); each org's tasks keep their own controller, and the
 * `AllListController` queues every op under its task's org.
 */
export function AllListView({ orgs, userId, defaultOrgId, view, label, pane }: AllListViewProps) {
  const { t } = useTranslation('list');
  const pipeline = useListPipeline();
  const queryClient = useQueryClient();
  const dateCtx = useViewerDateContext();
  const orgIds = useMemo(() => orgs.map((org) => org.id), [orgs]);
  const status = useOrgListsStatus(orgIds);
  const tags = useOrgsTags(orgIds);
  useEffect(() => setTags(tags), [tags]);
  const sharedIds = useMemo(
    () => orgs.filter((org) => !org.isPersonal).map((org) => org.id),
    [orgs],
  );
  const membersData = useOrgsMembers(sharedIds);
  const members = useMemo(
    () =>
      new Map([...membersData].map(([orgId, list]) => [orgId, sortMembers(list, userId)] as const)),
    [membersData, userId],
  );
  const membersRef = useRef(members);
  membersRef.current = members;
  const rowsRef = useRef<readonly Row[]>([]);
  const viewRef = useRef<ViewModel | null>(null);
  const dateRef = useRef(dateCtx);
  dateRef.current = dateCtx;
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const defaultRef = useRef(defaultOrgId);
  defaultRef.current = defaultOrgId;
  const prefsRef = useLivePrefs();
  const orgsById = useMemo(() => new Map(orgs.map((org) => [org.id, org])), [orgs]);

  // One controller per org (its groups, tags and people), all over the same rows and store.
  const common = useMemo(
    () => ({
      userId,
      pipeline,
      t: t as unknown as Translate,
      rows: () => rowsRef.current,
      dateContext: () => dateRef.current,
      prefs: () => prefsRef.current,
      pane: {
        isOpen: () => Boolean(paneRef.current?.taskId()),
        close: () => paneRef.current?.close(),
      },
      view: () => viewRef.current,
    }),
    [userId, pipeline, t, prefsRef],
  );
  const scopes = useMemo<AllOrgScope[]>(
    () =>
      orgs.map((org) => ({
        org,
        controller: new ListController({
          ...common,
          orgId: org.id,
          tags: () =>
            Object.values(useTagsStore.getState().byId).filter((tag) => tag.orgId === org.id),
          ...(org.isPersonal ? {} : { members: () => membersRef.current.get(org.id) ?? [] }),
        }),
      })),
    [orgs, common],
  );
  const scopesRef = useRef(scopes);
  scopesRef.current = scopes;
  const controller = useMemo(
    () =>
      new AllListController({
        ...common,
        tags: () => Object.values(useTagsStore.getState().byId),
        scopes: () => scopesRef.current,
        defaultOrgId: () => defaultRef.current,
      }),
    [common],
  );

  const membersFor = useCallback(
    (ids: readonly string[]): readonly OrgMember[] | null => {
      const orgId = controller.scoped(ids)?.orgId;
      return orgId ? (members.get(orgId) ?? null) : null;
    },
    [controller, members],
  );
  const refresh = useMemo(
    () => async () => {
      // 02 §13.2: flush the outbox (through the leader tab) and refetch every org's list.
      syncEngine()?.syncNow();
      await Promise.all(
        orgIds.map((orgId) => queryClient.invalidateQueries({ queryKey: myListKey(orgId) })),
      );
    },
    [queryClient, orgIds],
  );
  // Stable: data changes re-render only `AllRows`, never the layers above it.
  const rowsElement = useMemo(
    () => (
      <AllRows
        orgIds={orgIds}
        userId={userId}
        view={view}
        rowsRef={rowsRef}
        viewRef={viewRef}
        defaultOrgId={defaultOrgId}
      />
    ),
    [orgIds, userId, view, defaultOrgId],
  );

  return (
    <ListViewCore
      controller={controller}
      status={status}
      label={label}
      pane={pane}
      view={view}
      shared={sharedIds.length > 0}
      everyone={false}
      rowsRef={rowsRef}
      rowsElement={rowsElement}
      membersFor={membersFor}
      refresh={refresh}
      canMoveOrg={false}
      resetKey={`all|${view}`}
      orgs={orgsById}
    />
  );
}
