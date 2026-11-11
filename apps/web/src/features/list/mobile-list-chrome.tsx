import { orderedGroups } from '@rooster/core/reducers';
import type { Task } from '@rooster/core/schemas';
import { Calendar, CheckCircle2, FolderInput, Hash, Trash2, UserRound, X } from 'lucide-react';
import { type RefObject, Suspense, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMyList } from '../../data/list';
import type { OrgMember } from '../../data/types';
import { cn } from '../../lib/cn';
import { selectedIds, useListUi } from '../../state/list-store';
import { useTagsStore } from '../../state/tags-store';
import { AccessoryBar } from '../../ui/accessory-bar';
import { BottomNav } from '../../ui/bottom-nav';
import { Fab } from '../../ui/fab';
import { IconButton } from '../../ui/icon-button';
import type { SwipeRevealAction } from '../../ui/swipe-reveal';
import { useEditingFocus, useKeyboardInset } from '../../ui/use-media';
import { type DueValue, noDue, sameDue, useDateLabel } from '../dates';
import { QuickDateSheet } from '../dates/quick-date-sheet';
import { AssigneeSheet } from '../people/assignee-sheet';
import { TagSheet } from '../tags/tag-sheet';
import { announce } from './announcer';
import type { ListController } from './controller';
import { type GroupChoice, GroupSheet } from './group-sheet';
import { LazyRecurringDeleteSheet, LazyTaskReminders } from './lazy';
import { useListContext } from './list-context';
import { type SwipePrefs, SwipeRows } from './swipe-rows';
import { titleInputHandle } from './title-input';

function dueOf(task: Task | undefined): DueValue {
  return task
    ? {
        dueDate: task.dueDate,
        dueTime: task.dueTime,
        dueTz: task.dueTz,
        startDate: task.startDate,
        recurrence: task.recurrence ?? null,
        recurrenceBasis: task.recurrenceBasis ?? null,
      }
    : noDue;
}

/** The due value shared by all `tasks`, or none. */
function commonDue(tasks: readonly (Task | undefined)[]): DueValue {
  const first = dueOf(tasks[0]);
  return tasks.every((task) => sameDue(dueOf(task), first)) ? first : noDue;
}

function groupChoices(controller: ListController): GroupChoice[] {
  const state = controller.state();
  return state
    ? orderedGroups(state).map((g) => ({ id: g.id, name: g.name, inbox: g.kind === 'inbox' }))
    : [];
}

export interface MobileListChromeProps {
  orgId: string;
  /** The tree grid, for the delegated swipe handler. */
  rootRef: RefObject<HTMLElement | null>;
  /** The positioned wrapper the swipe reveal is drawn in. */
  layerRef: RefObject<HTMLElement | null>;
  swipePrefs: SwipePrefs;
  /** Overdue takes no inline adds (02 §10): no FAB. */
  canAdd?: boolean;
  /** A shared org's members (me first): the assign sheet. Null in a personal org (FR-COL-6). */
  members?: readonly OrgMember[] | null;
}

/**
 * Everything the phone layers over My tasks (02 §13): swipe actions, the FAB, the accessory
 * bar above the keyboard, selection mode's header and bulk bar, and the bottom sheets that
 * replace the desktop popovers (date, move, tags). Rendered by `MyListView` below 768 px.
 */
export function MobileListChrome({
  orgId,
  rootRef,
  layerRef,
  swipePrefs,
  canAdd = true,
  members = null,
}: MobileListChromeProps) {
  const { t } = useTranslation('mobile');
  const { t: tList } = useTranslation('list');
  const { controller, dateCtx } = useListContext();
  const editingFocus = useEditingFocus();
  const selectionMode = useListUi((s) => s.selectionMode);
  const popover = useListUi((s) => s.popover);
  const selectedCount = useListUi((s) => selectedIds(s).length);
  const editing = useListUi((s) => s.editing);
  const draft = useListUi((s) => s.drafts.find((d) => d.id === s.editing?.rowId));
  const dragging = useListUi((s) => s.dragging !== null);
  // A new row lifted by a long-press (ADR 0069) keeps the room below the list until it drops,
  // so the list doesn't jump under the finger when the keyboard goes.
  const room = useRef(false);
  room.current = draft !== undefined || (dragging && room.current);
  const tags = useTagsStore((s) => s.byId);
  // Re-render on list changes so sheet checks and labels follow.
  useMyList(orgId);

  const onSwipe = (rowId: string, action: SwipeRevealAction) => {
    const title = controller.task(rowId)?.title ?? '';
    if (action === 'complete') {
      controller.toggleComplete([rowId], { immediate: true });
    } else if (action === 'delete') {
      controller.deleteTasks([rowId]);
    } else {
      controller.ui().select(rowId);
      controller.ui().set({ popover: { kind: action === 'date' ? 'date' : 'moveTo', rowId } });
    }
    announce(t(`swipe.done.${action}`, { title }));
  };

  // ------------------------------------------------------------------ popover sheets
  // A draft's date (from its row's calendar or the accessory bar) has its own sheet below.
  const draftDateOpen =
    draft !== undefined && popover?.kind === 'date' && popover.rowId === draft.id;
  const sheetIds =
    popover &&
    !draftDateOpen &&
    (popover.kind === 'date' ||
      popover.kind === 'moveTo' ||
      popover.kind === 'tag' ||
      popover.kind === 'assign')
      ? popover.rowId === 'bulk' || selectionMode
        ? controller.selectedTaskIds()
        : // A draft is no task: if its edit ended while its sheet was open, nothing opens here.
          [popover.rowId].filter((id) => controller.task(id) !== undefined)
      : [];
  const sheetTasks = sheetIds.map((id) => controller.task(id));
  const subject =
    sheetIds.length === 1
      ? (sheetTasks[0]?.title ?? '')
      : t('subject.tasks', { count: sheetIds.length });
  const closePopover = () => controller.ui().set({ popover: null });
  const allTags = useMemo(() => Object.values(tags), [tags]);
  const applied = allTags
    .filter((tag) => sheetTasks.length > 0 && sheetTasks.every((x) => x?.tagIds.includes(tag.id)))
    .map((tag) => tag.id);
  const firstAssignee = sheetTasks[0]?.assigneeId;
  const currentAssignee =
    firstAssignee !== undefined && sheetTasks.every((x) => x?.assigneeId === firstAssignee)
      ? firstAssignee
      : undefined;

  // ------------------------------------------------------------------ the draft's accessory bar
  const keyboard = useKeyboardInset();
  const [groupSheetOpen, setGroupSheetOpen] = useState(false);
  const draftSheetOpen = groupSheetOpen || draftDateOpen;
  const draftDue = draft?.due ?? noDue;
  const dateInfo = useDateLabel(draftDue, dateCtx);
  const groupName = draft ? (controller.state()?.groups[draft.groupId]?.name ?? '') : '';
  const openDraftSheet = (kind: 'date' | 'group') => {
    if (!draft) return;
    controller.ui().set({
      suspendedEdit: draft.id,
      ...(kind === 'date' ? { popover: { kind: 'date', rowId: draft.id } } : {}),
    });
    if (kind === 'group') setGroupSheetOpen(true);
  };
  const closeDraftSheet = () => {
    const id = controller.ui().suspendedEdit;
    setGroupSheetOpen(false);
    controller.ui().set({ suspendedEdit: null, ...(draftDateOpen ? { popover: null } : {}) });
    if (id) titleInputHandle(id)?.focus();
  };
  const showAccessory =
    draft !== undefined && editing !== null && !draft.parentId && (editingFocus || draftSheetOpen);

  return (
    <>
      {/*
       * Room below the list's end while a new row is typed: it is scrolled to the top, above
       * the keyboard, even when it is the last row (`scrollRowToListTop`).
       */}
      {room.current && <div aria-hidden data-draft-room className="h-dvh shrink-0" />}
      <SwipeRows
        rootRef={rootRef}
        layerRef={layerRef}
        controller={controller}
        enabled={!selectionMode}
        prefs={swipePrefs}
        onCommit={onSwipe}
      />

      {canAdd && (
        <Fab
          aria-label={t('fab.label')}
          isHidden={editingFocus || selectionMode}
          onPress={() => controller.quickAdd()}
        />
      )}

      {showAccessory && !draftSheetOpen && (
        <AccessoryBar
          bottom={keyboard}
          dateLabel={dateInfo?.label}
          groupLabel={groupName}
          onDate={() => openDraftSheet('date')}
          onGroup={() => openDraftSheet('group')}
          onTag={() => draft && titleInputHandle(draft.id)?.insert('#')}
          onNext={() => draft && titleInputHandle(draft.id)?.next()}
        />
      )}
      {draft && (
        <>
          <QuickDateSheet
            isOpen={draftDateOpen}
            onOpenChange={(open) => !open && closeDraftSheet()}
            value={draftDue}
            ctx={dateCtx}
            onCommit={(next) => controller.setDraftDue(draft.id, next)}
          />
          <GroupSheet
            isOpen={groupSheetOpen}
            onOpenChange={(open) => !open && closeDraftSheet()}
            title={t('accessory.groupTitle')}
            groups={groupChoices(controller).filter((g) => !g.inbox)}
            current={draft.groupId}
            onPick={(groupId) => controller.moveDraftToGroup(draft.id, groupId)}
          />
        </>
      )}

      {selectionMode && (
        <SelectionBars
          count={selectedCount}
          controller={controller}
          canAssign={members !== null}
          onDone={() => controller.exitSelectionMode()}
        />
      )}

      {popover?.kind === 'recurringDelete' && (
        <Suspense fallback={null}>
          <LazyRecurringDeleteSheet
            isOpen
            title={controller.task(popover.rowId)?.title ?? ''}
            onChoose={(choice) => controller.deleteRecurring(popover.rowId, choice)}
            onCancel={closePopover}
          />
        </Suspense>
      )}
      <QuickDateSheet
        isOpen={popover?.kind === 'date' && sheetIds.length > 0}
        onOpenChange={(open) => !open && closePopover()}
        value={commonDue(sheetTasks)}
        ctx={dateCtx}
        subject={subject}
        onCommit={(next) => controller.setDue(sheetIds, next)}
        // P10: one task repeats and has reminders; several get a plain date.
        repeatable={sheetIds.length === 1}
        renderReminders={
          sheetIds.length === 1
            ? (slot) => (
                <Suspense fallback={null}>
                  <LazyTaskReminders
                    taskId={sheetIds[0] as string}
                    controller={controller}
                    ctx={dateCtx}
                    slot={slot}
                  />
                </Suspense>
              )
            : undefined
        }
      />
      <GroupSheet
        isOpen={popover?.kind === 'moveTo' && sheetIds.length > 0}
        onOpenChange={(open) => !open && closePopover()}
        title={tList('bulk.moveTo')}
        groups={groupChoices(controller)}
        current={sheetIds.length === 1 ? sheetTasks[0]?.placement?.groupId : undefined}
        subject={subject}
        onPick={(groupId) => controller.moveToGroup(groupId, sheetIds)}
      />
      <TagSheet
        isOpen={popover?.kind === 'tag' && sheetIds.length > 0}
        onOpenChange={(open) => !open && closePopover()}
        tags={allTags}
        applied={applied}
        subject={subject}
        onToggle={(tagId) => controller.toggleTag(sheetIds, tagId)}
        onCreate={(name) => controller.createTagFor(sheetIds, name)}
      />
      {members && (
        <AssigneeSheet
          isOpen={popover?.kind === 'assign' && sheetIds.length > 0}
          onOpenChange={(open) => !open && closePopover()}
          members={members}
          meId={controller.deps.userId}
          current={currentAssignee}
          subject={subject}
          onPick={(assigneeId) => {
            controller.assign(sheetIds, assigneeId);
            if (selectionMode) controller.exitSelectionMode();
          }}
        />
      )}
    </>
  );
}

/**
 * Selection mode (02 §13.2): a header with the count and Done over the top bar, and the bulk
 * actions where the bottom nav was.
 */
function SelectionBars({
  count,
  controller,
  canAssign,
  onDone,
}: {
  count: number;
  controller: ListController;
  /** A shared org: Assign replaces Move to (five actions fit the bar). */
  canAssign: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation('mobile');
  const { t: tList } = useTranslation('list');
  const bulk = (kind: 'date' | 'moveTo' | 'tag' | 'assign') =>
    controller.ui().set({ popover: { kind, rowId: 'bulk' } });
  const disabled = count === 0;
  const actions = [
    {
      id: 'complete',
      label: tList('bulk.complete'),
      icon: CheckCircle2,
      onPress: () => {
        controller.toggleComplete(controller.selectedTaskIds());
        onDone();
      },
    },
    { id: 'date', label: tList('bulk.date'), icon: Calendar, onPress: () => bulk('date') },
    canAssign && controller.isEveryone()
      ? {
          id: 'assign',
          label: tList('bulk.assign'),
          icon: UserRound,
          onPress: () => bulk('assign'),
        }
      : {
          id: 'move',
          label: tList('bulk.moveTo'),
          icon: FolderInput,
          // Nothing in Upcoming moves (ADR 0068); the controller says so.
          onPress: () => {
            if (controller.movable(controller.selectedTaskIds()).length > 0) bulk('moveTo');
          },
        },
    { id: 'tag', label: tList('bulk.tag'), icon: Hash, onPress: () => bulk('tag') },
    {
      id: 'delete',
      label: tList('bulk.delete'),
      icon: Trash2,
      onPress: () => {
        controller.deleteTasks(controller.selectedTaskIds());
        onDone();
      },
    },
  ].map((action) => ({ ...action, isDisabled: disabled }));

  return (
    <>
      <div
        data-testid="selection-header"
        className={cn(
          'fixed inset-x-0 top-0 z-(--z-bulk-bar) flex flex-col bg-bg-elevated pt-safe shadow-md',
          'animate-fade-in',
        )}
      >
        <div className="flex h-sheet-header items-center gap-2 px-2">
          <IconButton icon={X} aria-label={t('selection.done')} onPress={onDone} size="lg" />
          <span className="flex-1 truncate text-group tabular-nums" aria-live="polite">
            {tList('bulk.selected', { count })}
          </span>
          <span className="pe-2 text-sm text-text-muted">{t('selection.hint')}</span>
        </div>
      </div>
      <BottomNav
        label={tList('bulk.label', { count })}
        items={actions}
        kind="toolbar"
        className="fixed inset-x-0 bottom-0 z-(--z-bulk-bar) animate-fade-in"
      />
    </>
  );
}
