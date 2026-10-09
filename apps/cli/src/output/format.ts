import {
  type DateFormat,
  dueInstant,
  dueState,
  formatRelative,
  type TimeFormat,
  todayIn,
} from '@rooster/core/dates';
import type { Tag, Task } from '../api.ts';
import type { Locale } from '../i18n.ts';
import {
  type ColorLevel,
  clean,
  displayWidth,
  padEnd,
  padStart,
  paint,
  truncate,
} from './color.ts';
import { dueStyle, styles, tagStyle } from './theme.ts';

/** How the viewer reads dates: their today, zone and formats (ADR 0001). */
export interface DateContext {
  today: string;
  nowMs: number;
  timezone: string;
  locale: Locale;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
}

export function dateContext(
  me: { timezone: string; dateFormat: DateFormat; timeFormat: TimeFormat },
  locale: Locale,
  nowMs: number,
): DateContext {
  return {
    today: todayIn(me.timezone, nowMs),
    nowMs,
    timezone: me.timezone,
    locale,
    dateFormat: me.dateFormat,
    timeFormat: me.timeFormat,
  };
}

const hhmm = new Map<string, Intl.DateTimeFormat>();

function hhmmIn(timeZone: string, instant: number): string {
  let format = hhmm.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    hhmm.set(timeZone, format);
  }
  const parts = format.formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${part('hour')}:${part('minute')}`;
}

/** A timed due set in another zone, moved to the viewer's (ADR 0001 §5); dates stay floating. */
export function localDue(
  task: Pick<Task, 'dueDate' | 'dueTime' | 'dueTz'>,
  timezone: string,
): { date: string; time: string | null } | null {
  if (task.dueDate === null) return null;
  if (task.dueTime === null) return { date: task.dueDate, time: null };
  if (task.dueTz === null || task.dueTz === timezone) {
    return { date: task.dueDate, time: task.dueTime };
  }
  const instant = dueInstant(task.dueDate, task.dueTime, task.dueTz);
  return { date: todayIn(timezone, instant), time: hhmmIn(timezone, instant) };
}

/** The relative due label and its 03 §2.3 state, or null without a due date. */
export function dueLabel(
  task: Pick<Task, 'dueDate' | 'dueTime' | 'dueTz' | 'startDate' | 'completedAt'>,
  ctx: DateContext,
): { text: string; state: ReturnType<typeof dueState> } | null {
  const local = localDue(task, ctx.timezone);
  if (local === null) return null;
  const text = formatRelative(
    { dueDate: local.date, dueTime: local.time, startDate: task.startDate },
    ctx,
  );
  const state = dueState(
    {
      dueDate: task.dueDate,
      dueTime: task.dueTime,
      dueTz: task.dueTz,
      completed: task.completedAt !== null,
    },
    { today: ctx.today, nowMs: ctx.nowMs, viewerTz: ctx.timezone },
  );
  // The non-colour cue for overdue (03 §2.3 uses an icon on the web).
  return { text: state === 'overdue' ? `! ${text}` : text, state };
}

export interface RowOptions {
  /** Tag lookup for chips. */
  tags: ReadonlyMap<string, Tag>;
  dates: DateContext;
  /** Indentation level (subtasks under their parent). */
  depth?: number;
  /** Shown before the seq (`acme#12`), for output that mixes orgs. */
  orgSlug?: string;
  /** A muted prefix such as the parent title (`Plan trip ›`). */
  breadcrumb?: string;
  /** Muted text after the tags, e.g. the assignee in Everyone's tasks. */
  extra?: string;
}

export interface Row {
  ref: string;
  done: boolean;
  depth: number;
  title: string;
  breadcrumb: string | null;
  tags: { name: string; color: string }[];
  subtasks: string | null;
  extra: string | null;
  due: { text: string; state: ReturnType<typeof dueState> } | null;
}

export function taskRef(task: Pick<Task, 'seq' | 'id'>, orgSlug?: string): string {
  const seq = task.seq === null ? task.id.slice(0, 8) : String(task.seq);
  return orgSlug === undefined ? seq : `${orgSlug}#${seq}`;
}

export function toRow(task: Task, options: RowOptions): Row {
  const tags = task.tagIds.flatMap((id) => {
    const tag = options.tags.get(id);
    return tag === undefined ? [] : [{ name: clean(tag.name), color: tag.color }];
  });
  return {
    ref: taskRef(task, options.orgSlug),
    done: task.completedAt !== null,
    depth: options.depth ?? 0,
    title: clean(task.title).replace(/\s+/g, ' '),
    breadcrumb: options.breadcrumb === undefined ? null : clean(options.breadcrumb),
    tags,
    subtasks:
      task.counts.subtasks > 0 ? `▸ ${task.counts.subtasksDone}/${task.counts.subtasks}` : null,
    extra: options.extra === undefined ? null : clean(options.extra),
    due: dueLabel(task, options.dates),
  };
}

function metaText(row: Row): string {
  return [
    ...row.tags.map((tag) => `#${tag.name}`),
    ...(row.subtasks ? [row.subtasks] : []),
    ...(row.extra ? [row.extra] : []),
  ].join(' ');
}

function titleText(row: Row): string {
  const indent = '  '.repeat(row.depth);
  return `${indent}${row.breadcrumb === null ? '' : `${row.breadcrumb} › `}${row.title}`;
}

/** A day header (Next 7 days): the same relative label as the due cell. */
export function dayLabel(date: string, ctx: DateContext): string {
  return formatRelative({ dueDate: date }, ctx);
}

/**
 * Aligned task lines (07 §4.1): seq, check mark, title, tags and subtask progress, due label.
 * Widths are shared by every row passed in, so a whole listing lines up; titles are cut to
 * the terminal width only when `columns` is set (a TTY).
 */
export function renderRows(
  rows: readonly Row[],
  level: ColorLevel,
  columns: number | null,
): string[] {
  if (rows.length === 0) return [];
  const refW = Math.max(4, ...rows.map((r) => displayWidth(r.ref)));
  const metaW = Math.max(0, ...rows.map((r) => displayWidth(metaText(r))));
  const dueW = Math.max(0, ...rows.map((r) => displayWidth(r.due?.text ?? '')));
  const longest = Math.max(...rows.map((r) => displayWidth(titleText(r))));
  const fixed = 1 + refW + 2 + 2 + (metaW > 0 ? 2 + metaW : 0) + (dueW > 0 ? 2 + dueW : 0);
  const titleW = columns === null ? longest : Math.min(longest, Math.max(16, columns - fixed));

  return rows.map((row) => {
    const ref = paint(padStart(row.ref, refW + 1), styles.muted, level);
    const mark = row.done ? paint('✓', styles.check, level) : '○';
    const indent = '  '.repeat(row.depth);
    const crumb = row.breadcrumb === null ? '' : `${row.breadcrumb} › `;
    const fullTitle = `${indent}${crumb}${row.title}`;
    const cut = truncate(fullTitle, titleW);
    const visibleCrumb = cut.slice(indent.length, indent.length + crumb.length);
    const rest = cut.slice(indent.length + visibleCrumb.length);
    const title =
      indent +
      paint(visibleCrumb, styles.muted, level) +
      paint(rest, row.done ? styles.done : {}, level) +
      ' '.repeat(Math.max(0, titleW - displayWidth(cut)));
    const meta = [
      ...row.tags.map((tag) => paint(`#${tag.name}`, tagStyle(tag.color), level)),
      ...(row.subtasks ? [paint(row.subtasks, styles.muted, level)] : []),
      ...(row.extra ? [paint(row.extra, styles.muted, level)] : []),
    ].join(' ');
    const metaCell = metaW > 0 ? `  ${meta}${' '.repeat(metaW - displayWidth(metaText(row)))}` : '';
    const due =
      row.due === null
        ? ''
        : paint(row.due.text, row.due.state === 'none' ? {} : dueStyle(row.due.state), level);
    const dueCell = dueW > 0 ? `  ${due}` : '';
    return `${ref}  ${mark} ${title}${metaCell}${dueCell}`.trimEnd();
  });
}

/** A section header: `Prio (2)`. */
export function header(name: string, count: number | null, level: ColorLevel): string {
  const suffix = count === null ? '' : ` ${paint(`(${count})`, styles.muted, level)}`;
  return `${paint(name, styles.heading, level)}${suffix}`;
}

export function padCell(text: string, width: number): string {
  return padEnd(text, width);
}
