import { ancestorsOf, type ListState, listOps, orderedGroups } from '@rooster/core/reducers';
import type { Task } from '@rooster/core/schemas';
import {
  Check,
  Copy,
  FolderInput,
  Hash,
  Link2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Plus,
  SquareArrowOutUpRight,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorCode, useDisplayPrefs, useMe, useOrgMembers } from '../../data';
import { useListPipeline, useMyListSelect } from '../../data/list';
import { useTaskDetail } from '../../data/task-detail';
import { primaryKeys } from '../../keymap';
import { cn } from '../../lib/cn';
import { formatTimeAgo } from '../../lib/format';
import { createListStore } from '../../state/list-store';
import { type PaneFocusTarget, usePaneStore } from '../../state/pane-store';
import { useTagsStore } from '../../state/tags-store';
import { Button } from '../../ui/button';
import { ChipGroup } from '../../ui/chip';
import { IconButton } from '../../ui/icon-button';
import {
  Menu,
  MenuItem,
  MenuPopover,
  MenuSeparator,
  MenuTrigger,
  SubmenuTrigger,
} from '../../ui/menu';
import { Select } from '../../ui/select';
import { toast } from '../../ui/toast';
import {
  eventZone,
  type ShortcutHandler,
  type ShortcutHandlers,
  useKeymapHandlers,
} from '../../use-keymap';
import { DateCell, type DueValue, useViewerDateContext } from '../dates';
import { completionHoldMs, ListController, type Translate } from '../list/controller';
import type { ListContextValue } from '../list/list-context';
import type { Row } from '../list/model/rows';
import { TagPicker } from '../tags/tag-picker';
import { DescriptionField } from './description-field';
import type { PaneControls } from './pane-controls';
import { PaneSubtasks } from './pane-subtasks';
import { PaneTitle, type PaneTitleHandle } from './pane-title';
import { SaveState } from './save-state';

/**
 * What the pane needs from the list: its task (without the sort key, which a move changes),
 * the full parent chain when the list knows it, and the groups. Structurally shared.
 */
function paneSlice(state: ListState, taskId: string) {
  const task = state.tasks[taskId];
  const known = task ? ancestorsOf(state, taskId).reverse() : [];
  const complete = known.length > 0 && known[0]?.parentId === null;
  return {
    task: task && {
      ...task,
      placement: task.placement && { groupId: task.placement.groupId, position: '' },
    },
    chain: complete ? known.map((a) => ({ id: a.id, title: a.title })) : null,
    groups: orderedGroups(state).map((g) => ({ id: g.id, name: g.name })),
  };
}

export interface DetailPaneProps {
  orgId: string;
  orgSlug: string;
  userId: string;
  taskId: string;
  pane: PaneControls;
  fullScreen: boolean;
  /** Esc in the pane (02 §9.1): focus goes back to the list. */
  onFocusList: () => void;
}

/** Keys pressed with focus in the pane act on the pane's task. */
function inPane(handlers: ShortcutHandlers): ShortcutHandlers {
  const out: ShortcutHandlers = {};
  for (const [id, handler] of Object.entries(handlers) as [
    keyof ShortcutHandlers,
    ShortcutHandler,
  ][]) {
    out[id] = (event) => (eventZone(event) === 'pane' ? handler(event) : false);
  }
  return out;
}

export function taskUrl(orgSlug: string, taskId: string): string {
  return `${globalThis.location?.origin ?? ''}/o/${orgSlug}/t/${taskId}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The detail pane (02 §9, FR-DET): toolbar, breadcrumb, title, properties, description and
 * subtasks of one task. Every edit goes through the mutation pipeline; the content crossfades
 * when the task changes.
 */
export function DetailPane(props: DetailPaneProps) {
  const { taskId } = props;
  // A fresh subtree per task: pending title edits commit on unmount, focus state resets.
  return <PaneContent key={taskId} {...props} />;
}

function PaneContent({
  orgId,
  orgSlug,
  userId,
  taskId,
  pane,
  fullScreen,
  onFocusList,
}: DetailPaneProps) {
  const { t } = useTranslation('pane');
  const { t: tList } = useTranslation('list');
  const pipeline = useListPipeline();
  const list = useMyListSelect(
    orgId,
    useCallback((state: ListState) => paneSlice(state, taskId), [taskId]),
  );
  const inList = useMyListSelect(
    orgId,
    useCallback((state: ListState) => taskId in state.tasks, [taskId]),
  ).data;
  const detail = useTaskDetail(taskId, orgId, userId, inList === true);
  const dateCtx = useViewerDateContext();
  const prefs = useMe().data?.prefs;
  const display = useDisplayPrefs();
  const members = useOrgMembers(orgId);
  const tagsById = useTagsStore((s) => s.byId);
  const focus = usePaneStore((s) => s.focus);
  const titleRef = useRef<PaneTitleHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tagButton = useRef<HTMLSpanElement>(null);
  const subRows = useRef<readonly Row[]>([]);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const dateRef = useRef(dateCtx);
  dateRef.current = dateCtx;
  const tagsRef = useRef(Object.values(tagsById));
  tagsRef.current = Object.values(tagsById);

  const slice = list.data;
  const listTask = slice?.task;
  const task: Task | undefined = listTask ?? detail.data;
  const description = detail.data?.description ?? listTask?.description ?? '';
  const chain = slice?.chain ?? detail.data?.parentChain ?? [];

  const controller = useMemo(
    () =>
      new ListController({
        orgId,
        userId,
        pipeline,
        t: tList as unknown as Translate,
        rows: () => subRows.current,
        dateContext: () => dateRef.current,
        prefs: () => ({
          parseTitles: prefs?.parseTitleDates ?? true,
          holdMs: prefs?.completeHideMs ?? completionHoldMs,
        }),
        tags: () => tagsRef.current,
        store: createListStore({ showCompleted: true }),
        rootTaskId: taskId,
      }),
    [orgId, userId, pipeline, tList, taskId, prefs?.parseTitleDates, prefs?.completeHideMs],
  );

  const context = useMemo<Omit<ListContextValue, 'controller' | 'baseLevel'>>(
    () => ({
      dateCtx,
      parseTitles: prefs?.parseTitleDates ?? true,
      dragEnabled: true,
      onOpenTask: (id, withFocus) => pane.open(id, withFocus ? 'title' : null),
    }),
    [dateCtx, prefs?.parseTitleDates, pane],
  );

  // Focus requests (O / Tab+Enter: the title; Tab+R: the description), once the task is here.
  useEffect(() => {
    if (!focus || !task) return;
    applyFocus(focus.target);
    usePaneStore.getState().clearFocus();
  }, [focus, task]);

  const applyFocus = (target: PaneFocusTarget) => {
    if (target === 'title') titleRef.current?.focus();
    else if (target === 'description') {
      bodyRef.current
        ?.querySelector<HTMLElement>('[data-testid="description-field"] [contenteditable="true"]')
        ?.focus();
    } else if (target === 'tags') setTagsOpen(true);
    else if (target === 'date') setDateOpen(true);
    else if (target === 'subtask') controller.addSubtask(taskId);
  };

  const commitTitle = () => titleRef.current?.commit();
  const run = (label: string, specs: Parameters<ListController['run']>[1]) =>
    controller.run(label, specs);

  const toggleComplete = () => {
    if (!task) return;
    commitTitle();
    const complete = task.completedAt === null;
    if (listTask) controller.toggleComplete([taskId]);
    else run(tList('undo.edited'), [listOps.completeTask(taskId, complete)]);
  };
  const duplicate = () => {
    commitTitle();
    controller.duplicate([taskId]);
  };
  const remove = () => {
    controller.deleteTasks([taskId]);
    pane.close();
  };
  const copyLink = async () => {
    if (await copyText(taskUrl(orgSlug, taskId))) toast({ message: t('toolbar.linkCopied') });
  };
  const copyId = async () => {
    if (await copyText(taskId)) toast({ message: t('toolbar.idCopied') });
  };

  /** 02 §9.1: Esc leaves full screen first, then returns focus to the list. */
  const leavePane = () => {
    if (usePaneStore.getState().fullScreen) {
      usePaneStore.getState().setFullScreen(false);
      return;
    }
    commitTitle();
    onFocusList();
  };

  // Stable callbacks: the editor (the pane's heaviest part) re-renders only for a new value.
  const latest = useRef({ leavePane, toggleComplete });
  latest.current = { leavePane, toggleComplete };
  const descriptionCallbacks = useMemo(
    () => ({
      onChange: (markdown: string) =>
        pipeline.enqueue(orgId, [listOps.patchTask(taskId, { description: markdown })], {
          userId,
        }),
      onEscape: () => latest.current.leavePane(),
      onModEnter: () => latest.current.toggleComplete(),
    }),
    [pipeline, orgId, taskId, userId],
  );

  useKeymapHandlers(
    inPane({
      escape: leavePane,
      complete: () => toggleComplete(),
      duplicate: () => duplicate(),
      deleteTask: () => remove(),
      datePicker: () => setDateOpen(true),
      tagPicker: () => setTagsOpen(true),
      addSubtask: () => {
        commitTitle();
        controller.addSubtask(taskId);
      },
      focusDescription: () => applyFocus('description'),
      openPaneFocus: () => applyFocus('title'),
      paneFullScreen: () => pane.toggleFullScreen(),
    }),
  );

  if (!task) {
    const missing = errorCode(detail.error) === 'not_found' || detail.error;
    return (
      <div className="flex flex-col">
        <PaneToolbarShell fullScreen={fullScreen} pane={pane} />
        <p
          role={missing ? 'alert' : 'status'}
          className="p-6 text-sm text-text-secondary"
          aria-busy={!missing}
        >
          {missing
            ? errorCode(detail.error) === 'not_found' ||
              errorCode(detail.error) === 'invalid_parent'
              ? t('notFound')
              : t('loadFailed')
            : t('loading')}
        </p>
      </div>
    );
  }

  const done = task.completedAt !== null;
  const groups = slice?.groups ?? [];
  const creator =
    task.createdBy === userId
      ? t('props.you')
      : (members.data?.find((m) => m.userId === task.createdBy)?.name ?? '');
  const tagItems = task.tagIds.flatMap((id) => {
    const tag = tagsById[id];
    return tag ? [{ id: tag.id, name: tag.name, color: tag.color }] : [];
  });
  const due: DueValue = {
    dueDate: task.dueDate,
    dueTime: task.dueTime,
    dueTz: task.dueTz,
    startDate: task.startDate,
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="detail-pane" data-task-id={taskId}>
      <div
        role="toolbar"
        aria-label={t('toolbar.label')}
        className="flex h-toolbar shrink-0 items-center gap-1 border-b border-border px-3"
      >
        <Button
          size="sm"
          variant="secondary"
          icon={Check}
          onPress={toggleComplete}
          aria-pressed={done}
          data-testid="pane-complete"
          className={cn(done && 'border-transparent bg-bg-success-subtle text-text-success')}
        >
          {done ? t('toolbar.completed') : t('toolbar.complete')}
        </Button>
        <SaveState orgId={orgId} taskId={taskId} />
        <span className="flex-1" />
        <IconButton icon={Link2} aria-label={t('toolbar.copyLink')} onPress={copyLink} />
        <IconButton
          icon={Copy}
          aria-label={t('toolbar.duplicate')}
          shortcut={primaryKeys('duplicate')}
          onPress={duplicate}
        />
        <FullScreenButton fullScreen={fullScreen} pane={pane} />
        <MenuTrigger>
          <IconButton icon={MoreHorizontal} aria-label={t('toolbar.more')} />
          <MenuPopover placement="bottom end">
            <Menu aria-label={t('toolbar.more')}>
              {task.placement && groups.length > 0 && (
                <SubmenuTrigger>
                  <MenuItem icon={FolderInput}>{t('toolbar.moveTo')}</MenuItem>
                  <MenuPopover placement="start top">
                    <Menu
                      aria-label={t('toolbar.moveTo')}
                      selectionMode="single"
                      selectedKeys={[task.placement.groupId]}
                      onAction={(key) => controller.moveToGroup(String(key), [taskId])}
                    >
                      {groups.map((g) => (
                        <MenuItem key={g.id} id={g.id}>
                          {g.name}
                        </MenuItem>
                      ))}
                    </Menu>
                  </MenuPopover>
                </SubmenuTrigger>
              )}
              <MenuItem icon={Hash} onAction={copyId}>
                {t('toolbar.copyId')}
              </MenuItem>
              <MenuItem
                icon={SquareArrowOutUpRight}
                onAction={() => window.open(taskUrl(orgSlug, taskId), '_blank', 'noopener')}
              >
                {t('toolbar.openInNewTab')}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={Trash2}
                tone="danger"
                shortcut={primaryKeys('deleteTask')}
                onAction={remove}
              >
                {t('toolbar.delete')}
              </MenuItem>
            </Menu>
          </MenuPopover>
        </MenuTrigger>
        <IconButton
          icon={X}
          aria-label={t('toolbar.close')}
          shortcut={primaryKeys('escape')}
          onPress={() => pane.close()}
        />
      </div>
      <div
        ref={bodyRef}
        className="flex min-h-0 flex-1 animate-fade-in flex-col gap-6 overflow-y-auto p-6 max-tablet:px-3"
      >
        <div className="flex flex-col gap-2">
          {chain.length > 0 && (
            <nav aria-label={t('breadcrumb')} data-testid="pane-breadcrumb">
              <ol className="flex flex-wrap items-center gap-1 text-sm text-text-muted">
                {chain.map((link, i) => (
                  <li key={link.id} className="flex min-w-0 items-center gap-1">
                    {i > 0 && <span aria-hidden>›</span>}
                    <button
                      type="button"
                      className="max-w-64 truncate rounded-xs hover:text-text-secondary hover:underline focus-visible:outline-2 focus-visible:outline-border-focus"
                      onClick={() => pane.open(link.id, null)}
                    >
                      {link.title}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          )}
          <PaneTitle
            ref={titleRef}
            value={task.title}
            done={done}
            onCommit={(title) => run(tList('undo.edited'), [listOps.patchTask(taskId, { title })])}
            onEscape={leavePane}
          />
        </div>

        <dl
          aria-label={t('props.label')}
          className="grid grid-cols-[var(--w-label-col)_minmax(0,1fr)] items-center gap-x-3 text-sm"
        >
          <dt className="flex h-property-row items-center text-text-muted">{t('props.due')}</dt>
          <dd className="flex h-property-row min-w-0 items-center">
            <DateCell
              value={due}
              startDate={task.startDate}
              ctx={dateCtx}
              completed={done}
              rowHovered
              isOpen={dateOpen}
              onOpenChange={setDateOpen}
              onChange={(next) => controller.setDue([taskId], next)}
              className="justify-start"
            />
          </dd>
          {task.placement && groups.length > 0 && (
            <>
              <dt className="flex h-property-row items-center text-text-muted">
                {t('props.group')}
              </dt>
              <dd className="flex min-h-property-row min-w-0 items-center">
                <Select
                  label={t('props.groupLabel')}
                  hideLabel
                  options={groups.map((g) => ({ id: g.id, label: g.name }))}
                  value={task.placement.groupId}
                  onChange={(groupId) => controller.moveToGroup(groupId, [taskId])}
                  className="min-w-0"
                />
              </dd>
            </>
          )}
          <dt className="flex h-property-row items-center text-text-muted">{t('props.tags')}</dt>
          <dd className="flex min-h-property-row min-w-0 flex-wrap items-center gap-1.5 py-1">
            {tagItems.length > 0 && (
              <ChipGroup
                label={t('props.tags')}
                items={tagItems}
                onRemove={(tagId) => controller.removeTag(taskId, tagId)}
              />
            )}
            <span ref={tagButton} className="inline-flex">
              <IconButton
                icon={Plus}
                size="sm"
                aria-label={t('props.addTag')}
                shortcut={primaryKeys('tagPicker')}
                onPress={() => setTagsOpen(true)}
              />
            </span>
            {tagsOpen && tagButton.current && (
              <TagPicker
                anchor={tagButton.current}
                tags={Object.values(tagsById)}
                applied={task.tagIds}
                label={t('props.tags')}
                onToggle={(tagId) => controller.toggleTag([taskId], tagId)}
                onCreate={(name) => controller.createTagFor([taskId], name)}
                onClose={() => {
                  setTagsOpen(false);
                  tagButton.current?.querySelector('button')?.focus();
                }}
              />
            )}
          </dd>
          <dt className="flex h-property-row items-center text-text-muted">{t('props.created')}</dt>
          <dd className="flex h-property-row min-w-0 items-center text-text-muted">
            <span className="truncate">
              {t('props.createdBy', {
                name: creator,
                ago: formatTimeAgo(task.createdAt, Date.now(), display.locale, t('props.justNow')),
              })}
            </span>
          </dd>
        </dl>

        <section aria-label={t('description.label')}>
          <DescriptionField
            value={description}
            onChange={descriptionCallbacks.onChange}
            onEscape={descriptionCallbacks.onEscape}
            onModEnter={descriptionCallbacks.onModEnter}
          />
        </section>

        <section aria-labelledby="pane-subtasks-heading" className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h2
              id="pane-subtasks-heading"
              className="flex items-baseline gap-2 text-sm font-semibold text-text"
            >
              {t('subtasks.heading')}
              {task.counts.subtasks > 0 && (
                <span
                  className="font-normal text-text-muted tabular-nums"
                  data-testid="pane-subtask-count"
                >
                  {t('subtasks.progress', {
                    done: task.counts.subtasksDone,
                    total: task.counts.subtasks,
                  })}
                </span>
              )}
            </h2>
            <IconButton
              icon={Plus}
              size="sm"
              aria-label={t('subtasks.add')}
              shortcut={primaryKeys('addSubtask')}
              onPress={() => controller.addSubtask(taskId)}
            />
          </div>
          <PaneSubtasks
            orgId={orgId}
            userId={userId}
            task={task}
            fallback={detail.data?.subtasks ?? []}
            controller={controller}
            context={context}
            rowsRef={subRows}
            onEscapeOut={leavePane}
          />
        </section>
      </div>
    </div>
  );
}

function FullScreenButton({ fullScreen, pane }: { fullScreen: boolean; pane: PaneControls }) {
  const { t } = useTranslation('pane');
  return (
    <IconButton
      icon={fullScreen ? Minimize2 : Maximize2}
      aria-label={fullScreen ? t('toolbar.exitFullScreen') : t('toolbar.fullScreen')}
      shortcut={primaryKeys('paneFullScreen')}
      onPress={() => pane.toggleFullScreen()}
      className="max-tablet:hidden"
    />
  );
}

/** The toolbar while the task loads or is missing: close and full screen only. */
function PaneToolbarShell({ fullScreen, pane }: { fullScreen: boolean; pane: PaneControls }) {
  const { t } = useTranslation('pane');
  return (
    <div className="flex h-toolbar shrink-0 items-center justify-end gap-1 border-b border-border px-3">
      <FullScreenButton fullScreen={fullScreen} pane={pane} />
      <IconButton icon={X} aria-label={t('toolbar.close')} onPress={() => pane.close()} />
    </div>
  );
}
