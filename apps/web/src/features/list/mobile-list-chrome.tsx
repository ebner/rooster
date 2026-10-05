import { orderedGroups } from '@rooster/core/reducers';
import type { Task } from '@rooster/core/schemas';
import { Calendar, CheckCircle2, FolderInput, Hash, Trash2, X } from 'lucide-react';
import { type RefObject, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMyList } from '../../data/list';
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
import { TagSheet } from '../tags/tag-sheet';
import { announce } from './announcer';
import type { ListController } from './controller';
import { type GroupChoice, GroupSheet } from './group-sheet';
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
}

/**
 * Everything the phone layers over My tasks (02 §13): swipe actions, the FAB, the accessory
 * bar above the keyboard, selection mode's header and bulk bar, and the bottom sheets that
 * replace the desktop popovers (date, move, tags). Rendered by `MyListView` below 768 px.
 */
export function MobileListChrome({ orgId, rootRef, layerRef, swipePrefs }: MobileListChromeProps) {
  const { t } = useTranslation('mobile');
  const { t: tList } = useTranslation('list');
  const { controller, dateCtx } = useListContext();
  const editingFocus = useEditingFocus();
  const selectionMode = useListUi((s) => s.selectionMode);
  const popover = useListUi((s) => s.popover);
  const selectedCount = useListUi((s) => selectedIds(s).length);
  const editing = useListUi((s) => s.editing);
  const draft = useListUi((s) => s.drafts.find((d) => d.id === s.editing?.rowId));
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
  const sheetIds =
    popover && (popover.kind === 'date' || popover.kind === 'moveTo' || popover.kind === 'tag')
      ? popover.rowId === 'bulk' || selectionMode
        ? controller.selectedTaskIds()
        : [popover.rowId]
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

  // ------------------------------------------------------------------ the draft's accessory bar
  const keyboard = useKeyboardInset();
  const [draftSheet, setDraftSheet] = useState<'date' | 'group' | null>(null);
  const draftDue = draft?.due ?? noDue;
  const dateInfo = useDateLabel(draftDue, dateCtx);
  const groupName = draft ? (controller.state()?.groups[draft.groupId]?.name ?? '') : '';
  const openDraftSheet = (kind: 'date' | 'group') => {
    if (!draft) return;
    controller.ui().set({ suspendedEdit: draft.id });
    setDraftSheet(kind);
  };
  const closeDraftSheet = () => {
    const id = controller.ui().suspendedEdit;
    setDraftSheet(null);
    controller.ui().set({ suspendedEdit: null });
    if (id) titleInputHandle(id)?.focus();
  };
  const showAccessory =
    draft !== undefined &&
    editing !== null &&
    !draft.parentId &&
    (editingFocus || draftSheet !== null);

  return (
    <>
      <SwipeRows
        rootRef={rootRef}
        layerRef={layerRef}
        controller={controller}
        enabled={!selectionMode}
        prefs={swipePrefs}
        onCommit={onSwipe}
      />

      <Fab
        aria-label={t('fab.label')}
        isHidden={editingFocus || selectionMode}
        onPress={() => controller.quickAdd()}
      />

      {showAccessory && draftSheet === null && (
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
            isOpen={draftSheet === 'date'}
            onOpenChange={(open) => !open && closeDraftSheet()}
            value={draftDue}
            ctx={dateCtx}
            onCommit={(next) => controller.setDraftDue(draft.id, next)}
          />
          <GroupSheet
            isOpen={draftSheet === 'group'}
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
          onDone={() => controller.exitSelectionMode()}
        />
      )}

      <QuickDateSheet
        isOpen={popover?.kind === 'date' && sheetIds.length > 0}
        onOpenChange={(open) => !open && closePopover()}
        value={commonDue(sheetTasks)}
        ctx={dateCtx}
        subject={subject}
        onCommit={(next) => controller.setDue(sheetIds, next)}
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
  onDone,
}: {
  count: number;
  controller: ListController;
  onDone: () => void;
}) {
  const { t } = useTranslation('mobile');
  const { t: tList } = useTranslation('list');
  const bulk = (kind: 'date' | 'moveTo' | 'tag') =>
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
    { id: 'move', label: tList('bulk.moveTo'), icon: FolderInput, onPress: () => bulk('moveTo') },
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
