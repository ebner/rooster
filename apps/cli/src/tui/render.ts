import { formatRelative } from '@rooster/core/dates';
import { mentionsToPlain } from '@rooster/core/mentions';
import type { Task } from '@rooster/core/schemas';
import type { TaskDetail } from '../api.ts';
import { type ColorLevel, clean, displayWidth, type Style } from '../output/color.ts';
import { BELL_MARK, dueLabel, localDue, REPEAT_MARK, taskRef } from '../output/format.ts';
import { renderMarkdown } from '../output/markdown.ts';
import { listOf, offsetText, reminderText, ruleText, sizeText } from '../output/schedule.ts';
import { dueStyle, styles, tagStyle, token } from '../output/theme.ts';
import type {
  ActivityItem,
  DatePreview,
  DetailState,
  Mode,
  PickerOption,
  TuiController,
  TuiState,
} from './controller.ts';
import type { TuiTranslate } from './i18n.ts';
import type { LineInput } from './input.ts';
import { bindingOf, FOOTER, GO_KEYS, KEYMAP } from './keymap.ts';
import { indexOfKey, LIST_VIEWS, type Line, type TaskLine } from './model.ts';
import { ellipsize, fit, padAnsi, type Seg, seg, segsWidth, wrapAnsi } from './text.ts';

/**
 * The full-screen frame (07 §5) as exact-width text lines: a box with the org, sync status and
 * view tabs on top, the list (and the detail view, split at ≥ 120 columns), and the key hints
 * at the bottom. Pure: the same state and size always give the same frame.
 */

/** 07 §5: the detail view splits the screen from this width, else it takes it over. */
export const SPLIT_MIN_COLUMNS = 120;
/** Below this the frame cannot be drawn; a one-line notice says so. */
export const MIN_COLUMNS = 30;
export const MIN_ROWS = 8;
/** Modes that type into the list (title, draft, pickers); they show over narrow details. */
const EDITING: ReadonlySet<Mode['kind']> = new Set(['edit', 'draft', 'date', 'tag', 'group']);
/** Rows of a picker's option list. */
const PICKER_ROWS = 8;

export interface FrameContext {
  controller: TuiController;
  state: TuiState;
  width: number;
  height: number;
  level: ColorLevel;
  t: TuiTranslate;
  collab: TuiTranslate;
  /** The list's first visible row in the previous frame (scrolling is sticky). */
  top: number;
}

export interface Frame {
  lines: string[];
  top: number;
  /** Rows of the list area, for page moves. */
  bodyRows: number;
}

const muted = styles.muted;
const accent = styles.accent;
const border = { fg: token('border-strong') } satisfies Style;

interface Ctx extends FrameContext {
  inner: number;
}

export function renderFrame(input: FrameContext): Frame {
  const { width, height, level, t } = input;
  if (width < MIN_COLUMNS || height < MIN_ROWS) {
    const lines = Array.from({ length: Math.max(1, height) }, (_, i) =>
      fit(i === 0 ? [seg(t('tooSmall'), muted)] : [], Math.max(1, width), level),
    );
    return { lines, top: input.top, bodyRows: 1 };
  }
  const ctx: Ctx = { ...input, inner: width - 4 };
  const bodyRows = height - 6;
  const detail = input.state.detail;
  const split = detail !== null && width >= SPLIT_MIN_COLUMNS && input.state.mode.kind !== 'help';
  const listWidth = split ? Math.floor((ctx.inner - 3) * 0.55) : ctx.inner;
  const detailWidth = ctx.inner - 3 - listWidth;

  let body: string[];
  let top = input.top;
  if (input.state.mode.kind === 'help') {
    body = helpBody(ctx, input.state.mode.scroll, bodyRows);
  } else if (detail !== null && !split && !EDITING.has(input.state.mode.kind)) {
    // Full-screen details give way while a row is edited or a picker is open: the input
    // must be visible where it goes.
    body = detailBody(ctx, detail, ctx.inner, bodyRows);
  } else {
    const list = listBody(ctx, listWidth, bodyRows);
    top = list.top;
    body = list.lines;
    if (split && detail !== null) {
      const right = detailBody(ctx, detail, detailWidth, bodyRows);
      body = body.map((left, i) => `${left}${paint(' │ ', border, ctx)}${right[i] ?? ''}`);
    }
  }
  const bar = (left: string, join: string, right: string) => {
    if (!split) return paint(`${left}${'─'.repeat(width - 2)}${right}`, border, ctx);
    return paint(
      `${left}${'─'.repeat(listWidth + 2)}${join}${'─'.repeat(detailWidth + 2)}${right}`,
      border,
      ctx,
    );
  };
  const row = (content: string) =>
    `${paint('│', border, ctx)} ${content} ${paint('│', border, ctx)}`;
  const lines = [
    topBorder(ctx),
    row(tabs(ctx)),
    bar('├', '┬', '┤'),
    ...body.map(row),
    bar('├', '┴', '┤'),
    row(footer(ctx)),
    paint(`└${'─'.repeat(width - 2)}┘`, border, ctx),
  ];
  return { lines, top, bodyRows };
}

function paint(text: string, style: Style, ctx: Pick<Ctx, 'level'>): string {
  return fit([seg(text, style)], displayWidth(text), ctx.level);
}

// ---------------------------------------------------------------------------------------------
// Header

function status(ctx: Ctx): Seg {
  const { state, t } = ctx;
  if (state.saving > 0) return seg(`◌ ${t('status.saving')}`, styles.warning);
  switch (state.connection) {
    case 'live':
      return seg(`● ${t('status.synced')}`, styles.success);
    case 'connecting':
      return seg(`◌ ${t('status.connecting')}`, muted);
    case 'offline':
      return seg(`○ ${t('status.offline')}`, styles.danger);
  }
}

function topBorder(ctx: Ctx): string {
  const { width, level, state } = ctx;
  const right = status(ctx);
  const rightW = displayWidth(right.text) + 3;
  const orgs = state.me.orgs.length;
  const orgText = `${clean(state.org.name)} ▾${orgs > 1 ? ` 1–${Math.min(9, orgs)}` : ''}`;
  const head = [seg('┌ ', border), seg('rooster', accent), seg(' ─ ', border)];
  const room = width - segsWidth(head) - rightW - 2;
  const org = ellipsize(orgText, Math.max(1, room));
  const fill = Math.max(1, width - segsWidth(head) - displayWidth(org) - rightW - 1);
  return fit(
    [
      ...head,
      seg(org, { bold: true }),
      seg(` ${'─'.repeat(fill)} `, border),
      right,
      seg(' ┐', border),
    ],
    width,
    level,
  );
}

function tabs(ctx: Ctx): string {
  const { state, t, inner, level } = ctx;
  const items: { view: string; segs: Seg[] }[] = LIST_VIEWS.filter(
    (view) => view !== 'everyone' || !state.org.isPersonal,
  ).map((view) => {
    const count =
      view === 'today' ? state.counts?.today : view === 'overdue' ? state.counts?.overdue : 0;
    const segs: Seg[] = [
      seg(t(`view.${view}`), view === state.view ? { ...accent, underline: true } : {}),
    ];
    if (count !== undefined && count > 0) {
      segs.push(seg(` ${count}`, view === 'overdue' ? styles.danger : muted));
    }
    return { view, segs };
  });
  if (state.view === 'search') {
    items.push({
      view: 'search',
      segs: [seg(`/ ${state.search?.query ?? ''}`, { ...accent, underline: true })],
    });
  }
  const sep = seg(' │ ', border);
  const width = (list: typeof items) =>
    list.reduce((sum, item) => sum + segsWidth(item.segs), 0) + Math.max(0, list.length - 1) * 3;
  let shown = items;
  if (width(items) > inner) {
    // Keep the current tab and as many neighbours as fit.
    const at = Math.max(
      0,
      items.findIndex((item) => item.view === state.view),
    );
    let from = at;
    let to = at + 1;
    for (;;) {
      const grown =
        to < items.length && width(items.slice(from, to + 1)) <= inner
          ? [from, to + 1]
          : from > 0 && width(items.slice(from - 1, to)) <= inner
            ? [from - 1, to]
            : null;
      if (grown === null) break;
      [from, to] = grown as [number, number];
    }
    shown = items.slice(from, to);
  }
  const segs: Seg[] = [];
  shown.forEach((item, i) => {
    if (i > 0) segs.push(sep);
    segs.push(...item.segs);
  });
  return fit(segs, inner, level);
}

// ---------------------------------------------------------------------------------------------
// The list

function caret(input: LineInput, style: Style = {}): Seg[] {
  const chars = [...input.value];
  return [
    seg(clean(chars.slice(0, input.cursor).join('')), style),
    seg('▏', accent),
    seg(clean(chars.slice(input.cursor).join('')), style),
  ];
}

function dueSegs(task: Task, ctx: Ctx): Seg[] {
  const label = dueLabel(task, ctx.state.dates);
  if (label === null) return [];
  return [seg(label.text, label.state === 'none' ? {} : dueStyle(label.state))];
}

function metaSegs(line: TaskLine, ctx: Ctx): Seg[] {
  const out: Seg[] = [];
  const add = (s: Seg) => {
    if (out.length > 0) out.push(seg(' '));
    out.push(s);
  };
  if (line.chip !== null) add(seg(line.chip, muted));
  const tags = new Map(ctx.state.tags.map((tag) => [tag.id, tag]));
  for (const id of line.task.tagIds) {
    const tag = tags.get(id);
    if (tag !== undefined) add(seg(`#${clean(tag.name)}`, tagStyle(tag.color)));
  }
  const { subtasks, subtasksDone, comments } = line.task.counts;
  if (subtasks > 0) add(seg(`${line.expanded ? '▾' : '▸'} ${subtasksDone}/${subtasks}`, muted));
  if (line.task.hasDescription) add(seg('≡', muted));
  if (comments > 0) add(seg(`✎${comments}`, muted));
  if (typeof line.task.recurrence === 'string') add(seg(REPEAT_MARK, muted));
  if (typeof line.task.nextReminderAt === 'number') add(seg(BELL_MARK, muted));
  return out;
}

function taskRow(line: TaskLine, selected: boolean, ctx: Ctx, width: number): string {
  const task = line.task;
  const done = task.completedAt !== null;
  const mode = ctx.state.mode;
  const editing = mode.kind === 'edit' && mode.taskId === task.id;
  const left: Seg[] = [
    seg(selected ? '› ' : '  ', accent),
    seg('  '.repeat(line.depth)),
    done ? seg('✓ ', styles.check) : seg('○ '),
  ];
  if (line.breadcrumb !== null) left.push(seg(`${line.breadcrumb} › `, muted));
  const titleStyle: Style = done ? styles.done : selected ? { bold: true } : {};
  if (editing) left.push(...caret(mode.input));
  else left.push(seg(clean(task.title).replace(/\s+/g, ' '), titleStyle));
  const due = dueSegs(task, ctx);
  let meta = metaSegs(line, ctx);
  const leftMin = Math.min(segsWidth(left), 4 + 2 * line.depth + 12);
  const dueW = segsWidth(due);
  // Narrow terminals drop the chips first, then the date (the title always stays).
  if (leftMin + 2 + segsWidth(meta) + (dueW > 0 ? 2 + dueW : 0) > width) meta = [];
  const showDue = dueW > 0 && leftMin + 2 + dueW <= width;
  const right: Seg[] = [...meta];
  if (showDue) {
    if (right.length > 0) right.push(seg('  '));
    right.push(...due);
  }
  const rightW = segsWidth(right);
  if (rightW === 0) return fit(left, width, ctx.level);
  return (
    fit(left, width - rightW - 2, ctx.level) + fit([seg('  '), ...right], rightW + 2, ctx.level)
  );
}

function headerRow(line: Line, selected: boolean, ctx: Ctx, width: number): string {
  const marker = seg(selected ? '› ' : '  ', accent);
  if (line.kind === 'group') {
    const inbox = line.group.kind === 'inbox';
    const name = inbox ? ctx.t('inbox') : clean(line.group.name);
    return fit(
      [
        marker,
        seg(`${line.collapsed ? '▸' : '▾'} `, muted),
        seg(name, inbox ? accent : styles.heading),
        seg(` (${line.count})`, muted),
      ],
      width,
      ctx.level,
    );
  }
  if (line.kind === 'section') {
    return fit(
      [
        marker,
        seg(line.title, line.tone === 'danger' ? styles.danger : styles.heading),
        seg(` (${line.count})`, muted),
      ],
      width,
      ctx.level,
    );
  }
  if (line.kind === 'empty') return fit([seg(`  ${line.text}`, muted)], width, ctx.level);
  return fit([], width, ctx.level);
}

function draftRow(mode: Extract<Mode, { kind: 'draft' }>, ctx: Ctx, width: number): string {
  return fit(
    [seg('› ', accent), seg('  '.repeat(mode.target.depth)), seg('○ '), ...caret(mode.input)],
    width,
    ctx.level,
  );
}

function pickerRows(ctx: Ctx, width: number, depth: number): string[] {
  const { state, t, controller, level } = ctx;
  const mode = state.mode;
  const pad = seg(`  ${'  '.repeat(depth)}  `);
  const frame = seg('│ ', muted);
  const rows: Seg[][] = [];
  if (mode.kind === 'date') {
    const typed = mode.input.value.trim();
    const preview = typed === '' ? null : controller.previewDate(mode.taskId, typed);
    const hint: Seg[] =
      mode.error !== null
        ? [seg(`  ${mode.error}`, styles.danger)]
        : preview === null
          ? [seg(`  ${t('picker.dateHint')}`, muted)]
          : 'error' in preview
            ? [seg('  ?', styles.danger)]
            : [seg(`  → ${describePreview(preview, mode.taskId, ctx)}`, styles.success)];
    rows.push([seg(`${t('picker.date')} `, styles.heading), ...caret(mode.input), ...hint]);
    controller.dateSuggestions().forEach((option, i) => {
      const chosen = typed === '' && i === mode.choice;
      const result =
        option.id === 'none' ? null : controller.previewDate(mode.taskId, option.phrase);
      const when =
        result === null ? '' : 'error' in result ? '' : `  ${describePreview(result, null, ctx)}`;
      rows.push([
        seg(chosen ? '› ' : '  ', accent),
        seg(option.phrase, chosen ? { bold: true } : {}),
        seg(when, muted),
      ]);
    });
  } else if (mode.kind === 'tag' || mode.kind === 'group') {
    const options = controller.pickerOptions(mode);
    rows.push([
      seg(`${t(mode.kind === 'tag' ? 'picker.tag' : 'picker.group')} `, styles.heading),
      ...caret(mode.input),
    ]);
    const choice = Math.min(mode.choice, options.length - 1);
    const from = Math.max(0, Math.min(choice - PICKER_ROWS + 1, options.length - PICKER_ROWS));
    options.slice(from, from + PICKER_ROWS).forEach((option: PickerOption, offset) => {
      const i = from + offset;
      const chosen = i === choice;
      const label: Seg[] =
        option.id === null
          ? [seg(t('picker.createTag', { name: option.label }), styles.success)]
          : mode.kind === 'tag'
            ? [seg(`#${option.label}`, option.color === null ? {} : tagStyle(option.color))]
            : [seg(option.label)];
      const number = mode.kind === 'group' && i < 9 && mode.input.value === '' ? `${i + 1} ` : '';
      rows.push([
        seg(chosen ? '› ' : '  ', accent),
        seg(number, muted),
        seg(option.checked ? '✓ ' : '  ', styles.check),
        ...label,
      ]);
    });
    if (options.length === 0) rows.push([seg(`  ${t('picker.none')}`, muted)]);
  }
  return rows.map((segs) => fit([pad, frame, ...segs], width, level));
}

function describeDue(
  due: { dueDate: string | null; dueTime: string | null; startDate: string | null },
  ctx: Ctx,
): string {
  if (due.dueDate === null) return ctx.t('date.noneLabel');
  return formatRelative(
    { dueDate: due.dueDate, dueTime: due.dueTime, startDate: due.startDate },
    ctx.state.dates,
  );
}

/** "Mon · ↻ Weekly on Monday · 🔔 1 h before": what the picker's phrase would set. */
function describePreview(preview: DatePreview, taskId: string | null, ctx: Ctx): string {
  const dates = ctx.state.dates;
  const parts: string[] = [];
  const task =
    taskId === null
      ? undefined
      : ctx.state.lines.find(
          (line): line is TaskLine => line.kind === 'task' && line.task.id === taskId,
        )?.task;
  if (preview.due !== null) {
    parts.push(describeDue(preview.due, ctx));
    if (typeof preview.due.recurrence === 'string') {
      parts.push(
        `${REPEAT_MARK} ${ruleText(preview.due.recurrence, preview.due.recurrenceBasis, dates)}`,
      );
    }
  }
  const dueTime = preview.due?.dueTime ?? task?.dueTime ?? null;
  for (const offset of preview.offsets) {
    parts.push(`${BELL_MARK} ${offsetText(offset, dueTime === null, dates)}`);
  }
  return parts.join(' · ');
}

function listBody(ctx: Ctx, width: number, height: number): { lines: string[]; top: number } {
  const { state } = ctx;
  if (state.list === null) {
    const rows = [fit([seg(`  ${ctx.t('loading')}`, muted)], width, ctx.level)];
    while (rows.length < height) rows.push(fit([], width, ctx.level));
    return { lines: rows, top: 0 };
  }
  const mode = state.mode;
  const rows: string[] = [];
  let focusStart = -1;
  let focusEnd = -1;
  const selectedIndex = indexOfKey(state.lines, state.selected);
  const draft = mode.kind === 'draft' ? mode : null;
  const anchor = draft === null ? -1 : indexOfKey(state.lines, draft.target.anchorKey);
  const pushDraft = () => {
    if (draft === null) return;
    focusStart = rows.length;
    rows.push(draftRow(draft, ctx, width));
    focusEnd = rows.length - 1;
  };
  if (draft !== null && anchor === -1) pushDraft();
  state.lines.forEach((line, i) => {
    if (draft !== null && i === anchor && draft.target.placement === 'before') pushDraft();
    const selected = draft === null && i === selectedIndex;
    if (selected) focusStart = rows.length;
    rows.push(
      line.kind === 'task'
        ? taskRow(line, selected, ctx, width)
        : headerRow(line, selected, ctx, width),
    );
    if (selected) {
      if (mode.kind === 'date' || mode.kind === 'tag' || mode.kind === 'group') {
        rows.push(...pickerRows(ctx, width, line.kind === 'task' ? line.depth : 0));
      }
      focusEnd = rows.length - 1;
    }
    if (draft !== null && i === anchor && draft.target.placement === 'after') pushDraft();
  });
  let top = ctx.top;
  if (focusStart !== -1) {
    top = Math.min(top, focusStart);
    top = Math.max(top, focusEnd - height + 1);
  }
  top = Math.max(0, Math.min(top, rows.length - height));
  const visible = rows.slice(top, top + height);
  while (visible.length < height) visible.push(fit([], width, ctx.level));
  return { lines: visible, top };
}

// ---------------------------------------------------------------------------------------------
// The detail view

function personName(ctx: Ctx, userId: string | null): string {
  const { state, collab } = ctx;
  if (userId === null) return collab('activity.system');
  if (userId === state.me.id) return collab('activity.you');
  const member = state.members?.find((m) => m.userId === userId);
  return clean(member?.name ?? '?');
}

function when(ctx: Ctx, ms: number): string {
  return new Intl.DateTimeFormat(ctx.state.dates.locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: ctx.state.dates.timeFormat === '12h' ? 'h12' : 'h23',
    timeZone: ctx.state.dates.timezone,
  }).format(ms);
}

function activityText(ctx: Ctx, item: NonNullable<ActivityItem['activity']>): string {
  const { collab, state } = ctx;
  const quote = (text: unknown) => collab('activity.quote', { text: clean(String(text ?? '')) });
  const data = item.data;
  switch (item.type) {
    case 'renamed':
      return `${collab('activity.renamed')} ${quote(data.to)}`;
    case 'due_changed': {
      const to = data.to as { dueDate: string | null; dueTime: string | null } | null;
      if (to === null || to.dueDate === null) return collab('activity.due_removed');
      return `${collab('activity.due_changed')} ${formatRelative({ dueDate: to.dueDate, dueTime: to.dueTime }, state.dates)}`;
    }
    case 'assigned': {
      const to = data.to as string | null;
      if (to === null) return collab('activity.unassigned');
      if (to === item.actorId) return collab('activity.tookIt');
      const name = to === state.me.id ? collab('activity.toYou') : personName(ctx, to);
      return `${collab('activity.assigned')} ${name}`;
    }
    case 'subtask_added':
      return collab('activity.subtask_added', { count: 1, titles: quote(data.title) });
    case 'moved_parent':
      return collab(data.to === null ? 'activity.moved_top' : 'activity.moved_under');
    case 'attachment_added':
      return collab('activity.attachment_added', {
        count: 1,
        files: clean(String(data.filename ?? '')),
      });
    case 'created':
    case 'completed':
    case 'reopened':
    case 'description_edited':
    case 'restored':
      return collab(`activity.${item.type}`);
    default:
      return clean(item.type);
  }
}

const VIA_LABELS = new Set(['cli', 'tui', 'mcp', 'pat', 'import']);

function detailLines(ctx: Ctx, detail: DetailState, width: number): string[] {
  const { t, level, state } = ctx;
  const out: string[] = [];
  const blank = () => out.push('');
  const wrap = (painted: string, indent = 0) => {
    for (const line of wrapAnsi(painted, width - indent)) out.push(' '.repeat(indent) + line);
  };
  const plain = (segs: Seg[]) => fit(segs, Math.min(width, segsWidth(segs)), level);
  const listed = state.lines.find(
    (line): line is TaskLine => line.kind === 'task' && line.task.id === detail.taskId,
  );
  const task: Task | TaskDetail | undefined = detail.task ?? listed?.task;
  if (task === undefined) {
    out.push(plain([seg(detail.error ?? t('loading'), detail.error ? styles.danger : muted)]));
    return out;
  }
  const done = task.completedAt !== null;
  wrap(
    plain([
      seg(`#${taskRef(task)} `, muted),
      done ? seg('✓ ', styles.check) : seg('○ '),
      seg(clean(task.title), done ? styles.done : { bold: true }),
    ]),
  );
  const rows: [string, Seg[]][] = [];
  const group = task.placement === null ? undefined : state.list?.groups[task.placement.groupId];
  if (group !== undefined) {
    rows.push([t('detail.group'), [seg(group.kind === 'inbox' ? t('inbox') : clean(group.name))]]);
  }
  if (detail.task !== null && detail.task.parentChain.length > 0) {
    rows.push([
      t('detail.parent'),
      [seg(detail.task.parentChain.map((p) => clean(p.title)).join(' › '))],
    ]);
  }
  const label = dueLabel(task, state.dates);
  if (label !== null) {
    const local = localDue(task, state.dates.timezone);
    const iso = `${task.startDate ? `${task.startDate} – ` : ''}${local?.date ?? ''}${local?.time ? ` ${local.time}` : ''}`;
    rows.push([
      t('detail.due'),
      [
        seg(label.text, label.state === 'none' ? {} : dueStyle(label.state)),
        seg(`  ${iso}`, muted),
      ],
    ]);
  }
  if (task.tagIds.length > 0) {
    const tags = new Map(state.tags.map((tag) => [tag.id, tag]));
    const segs: Seg[] = [];
    for (const id of task.tagIds) {
      const tag = tags.get(id);
      if (tag === undefined) continue;
      if (segs.length > 0) segs.push(seg(' '));
      segs.push(seg(`#${clean(tag.name)}`, tagStyle(tag.color)));
    }
    rows.push([t('detail.tags'), segs]);
  }
  if (typeof task.recurrence === 'string') {
    rows.push([
      t('detail.repeat'),
      [
        seg(
          `${REPEAT_MARK} ${clean(ruleText(task.recurrence, task.recurrenceBasis, state.dates))}`,
        ),
      ],
    ]);
  }
  listOf(detail.task?.reminders).forEach((reminder, i) => {
    const view = reminderText(reminder, task, state.dates);
    rows.push([
      i === 0 ? t('detail.reminders') : '',
      [seg(`${BELL_MARK} ${view.text}`, view.dormant || view.fired ? muted : {})],
    ]);
  });
  listOf(detail.task?.attachments).forEach((file, i) => {
    rows.push([
      i === 0 ? t('detail.attachments') : '',
      [
        seg(clean(String(file.filename))),
        seg(`  ${sizeText(file.size, state.dates.locale)}`, muted),
      ],
    ]);
  });
  if (!state.org.isPersonal) {
    rows.push([
      t('detail.assignee'),
      [seg(task.assigneeId === null ? t('detail.unassigned') : personName(ctx, task.assigneeId))],
    ]);
  }
  const labelW = Math.max(0, ...rows.map(([name]) => displayWidth(name)));
  for (const [name, value] of rows) {
    wrap(plain([seg(name.padEnd(labelW), muted), seg('  '), ...value]), 0);
  }
  if (detail.task === null) {
    blank();
    out.push(plain([seg(detail.error ?? t('loading'), detail.error ? styles.danger : muted)]));
    return out;
  }
  const full = detail.task;
  blank();
  if (full.description.trim() === '') out.push(plain([seg(t('detail.noDescription'), muted)]));
  else for (const line of renderMarkdown(full.description, level)) wrap(line);
  if (full.subtasks.length > 0) {
    blank();
    const doneCount = full.subtasks.filter((s) => s.completedAt !== null).length;
    out.push(
      plain([
        seg(t('detail.subtasks'), styles.heading),
        seg(` ${doneCount}/${full.subtasks.length}`, muted),
      ]),
    );
    for (const sub of full.subtasks) {
      const subDone = sub.completedAt !== null;
      const due = dueSegs(sub, ctx);
      wrap(
        plain([
          subDone ? seg('✓ ', styles.check) : seg('○ '),
          seg(clean(sub.title), subDone ? styles.done : {}),
          ...(due.length > 0 ? [seg('  '), ...due] : []),
        ]),
        2,
      );
    }
  }
  if (detail.activity !== null && detail.activity.length > 0) {
    blank();
    out.push(plain([seg(t('detail.activity'), styles.heading)]));
    for (const item of detail.activity) {
      if (item.kind === 'comment' && item.comment !== undefined) {
        const c = item.comment;
        wrap(
          plain([
            seg(personName(ctx, c.authorId), { bold: true }),
            seg(` · ${when(ctx, c.createdAt)}`, muted),
          ]),
          2,
        );
        for (const line of renderMarkdown(mentionsToPlain(c.body), level)) wrap(line, 4);
      } else if (item.activity !== undefined) {
        const a = item.activity;
        const via = VIA_LABELS.has(a.via) ? ` ${ctx.collab(`activity.via.${a.via}`)}` : '';
        wrap(
          plain([
            seg(personName(ctx, a.actorId), { bold: true }),
            seg(` ${activityText(ctx, a)}${via}`),
            seg(` · ${when(ctx, a.createdAt)}`, muted),
          ]),
          2,
        );
      }
    }
  }
  return out;
}

function detailBody(ctx: Ctx, detail: DetailState, width: number, height: number): string[] {
  const all = detailLines(ctx, detail, width).map((line) => padAnsi(line, width));
  const scroll = Math.max(0, Math.min(detail.scroll, all.length - height));
  const visible = all.slice(scroll, scroll + height);
  while (visible.length < height) visible.push(' '.repeat(width));
  return visible;
}

// ---------------------------------------------------------------------------------------------
// Help (generated from the keymap) and the footer

export function helpLines(t: TuiTranslate): { keys: string; text: string; heading?: boolean }[] {
  const out: { keys: string; text: string; heading?: boolean }[] = [
    { keys: '', text: t('help.title'), heading: true },
  ];
  for (const binding of KEYMAP) {
    if (binding.id === 'go') continue;
    out.push({ keys: binding.keys, text: t(`key.${binding.id}`) });
  }
  for (const [key, view] of Object.entries(GO_KEYS)) {
    out.push({ keys: `g ${key}`, text: t('key.go', { view: t(`view.${view}`) }) });
  }
  out.push({ keys: '', text: '' }, { keys: '', text: t('help.differences'), heading: true });
  for (const binding of KEYMAP) {
    if (binding.web === undefined) continue;
    out.push({ keys: binding.keys, text: t(`web.${binding.id}`, { web: binding.web ?? '' }) });
  }
  out.push({ keys: '', text: '' }, { keys: '', text: t('help.limits'), heading: true });
  out.push({ keys: '', text: t('help.undoLimits') }, { keys: '', text: t('help.offline') });
  return out;
}

function helpBody(ctx: Ctx, scroll: number, height: number): string[] {
  const { inner, level, t } = ctx;
  const entries = helpLines(t);
  const keysW = Math.max(...entries.map((e) => displayWidth(e.keys))) + 2;
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.heading) {
      lines.push(fit([seg(entry.text, styles.heading)], inner, level));
      continue;
    }
    if (entry.keys === '') {
      for (const line of wrapAnsi(entry.text, inner)) lines.push(padAnsi(line, inner));
      continue;
    }
    const wrapped = wrapAnsi(entry.text, Math.max(10, inner - keysW));
    wrapped.forEach((line, i) => {
      lines.push(
        fit([seg((i === 0 ? entry.keys : '').padEnd(keysW), accent), seg(line)], inner, level),
      );
    });
  }
  const top = Math.max(0, Math.min(scroll, lines.length - height));
  const visible = lines.slice(top, top + height);
  while (visible.length < height) visible.push(' '.repeat(inner));
  return visible;
}

/** Key hints that fit the width, in order; `last` (the help key) is always shown. */
function hints(ctx: Ctx, items: [string, string][], last?: [string, string]): string {
  const width = ([keys, text]: [string, string]) => displayWidth(keys) + 1 + displayWidth(text);
  const room = ctx.inner - (last === undefined ? 0 : width(last) + 2);
  const shown: [string, string][] = [];
  let used = 0;
  for (const item of items) {
    const w = width(item) + (shown.length > 0 ? 2 : 0);
    if (used + w > room) break;
    shown.push(item);
    used += w;
  }
  if (last !== undefined) shown.push(last);
  const segs: Seg[] = [];
  for (const [keys, text] of shown) {
    if (segs.length > 0) segs.push(seg('  '));
    segs.push(seg(keys, accent), seg(` ${text}`, muted));
  }
  return fit(segs, ctx.inner, ctx.level);
}

function footer(ctx: Ctx): string {
  const { state, t, inner, level } = ctx;
  const mode = state.mode;
  if (mode.kind === 'search') {
    return fit([seg('/ ', accent), ...caret(mode.input)], inner, level);
  }
  if (state.message !== null) {
    const m = state.message;
    // The keys come first when space is short: they are what the user can do about it.
    const keys = m.retry
      ? `  r ${t('hint.retry')}  Esc ${t('hint.dismiss')}`
      : m.undo
        ? `  u ${t('hint.undo')}`
        : '';
    const text = seg(m.text, m.tone === 'error' ? styles.danger : {});
    if (displayWidth(m.text) + displayWidth(keys) <= inner) {
      return fit([text, seg(keys, muted)], inner, level);
    }
    const keysW = Math.min(displayWidth(keys), inner - 8);
    return fit([text], inner - keysW, level) + fit([seg(keys, muted)], keysW, level);
  }
  if (state.goPending) {
    return hints(
      ctx,
      Object.entries(GO_KEYS).map(([key, view]) => [`g ${key}`, t(`view.${view}`)]),
    );
  }
  switch (mode.kind) {
    case 'edit':
    case 'draft':
      return hints(ctx, [
        ['Enter', t(mode.kind === 'draft' ? 'hint.addNext' : 'hint.save')],
        ['Esc', t('hint.done')],
      ]);
    case 'date':
    case 'tag':
    case 'group':
      return hints(ctx, [
        ['↑↓', t('hint.choose')],
        ['Enter', t(mode.kind === 'tag' ? 'hint.toggle' : 'hint.apply')],
        ['Esc', t('hint.close')],
      ]);
    case 'help':
      return hints(ctx, [
        ['j/k', t('hint.scroll')],
        ['Esc', t('hint.close')],
      ]);
    case 'navigate': {
      const items: [string, string][] = FOOTER.filter(
        (id) => id !== 'detail' || state.detail === null,
      ).map((id) => [
        id === 'down' ? 'j/k' : (bindingOf(id).keys.split(' ')[0] ?? ''),
        t(`hint.${id}`),
      ]);
      if (state.detail !== null) {
        items.splice(1, 0, ['e', t('hint.description')], ['o', t('hint.close')]);
      }
      // `? help` always shows (last): it explains everything else.
      return hints(
        ctx,
        items.filter(([keys]) => keys !== '?'),
        ['?', t('hint.help')],
      );
    }
  }
}
