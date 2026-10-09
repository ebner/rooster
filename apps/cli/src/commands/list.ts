import { compareKeys } from '@rooster/core/ordering';
import { inSmartView } from '@rooster/core/views';
import { defineCommand } from 'citty';
import { type Group, type Org, type Task, unwrap } from '../api.ts';
import { CliError, EXIT } from '../errors.ts';
import { findGroup } from '../grant-info.ts';
import { t } from '../i18n.ts';
import { clean, paint } from '../output/color.ts';
import {
  type DateContext,
  dayLabel,
  header,
  type Row,
  renderRows,
  taskRef,
  toRow,
} from '../output/format.ts';
import { styles } from '../output/theme.ts';
import { type Runtime, rt } from '../runtime.ts';
import { dates, multi, needs, positionals, tagMap } from './util.ts';

export const VIEWS = ['my', 'today', 'week', 'overdue', 'nodate', 'everyone'] as const;
export type View = (typeof VIEWS)[number];

export interface ListFlags {
  group?: string | undefined;
  tags: string[];
  completed: boolean;
  allOrgs: boolean;
  subtasks: boolean;
}

interface Section {
  title: string;
  rows: { task: Task; depth: number; breadcrumb?: string; extra?: string }[];
}

interface OrgResult {
  org: Org;
  view: View;
  groups: Group[] | null;
  tasks: Task[];
  sections: Section[];
}

const PAGE = 200;

/** Every page of `GET /orgs/:orgId/tasks` (the server already orders by view). */
async function queryTasks(
  runtime: Runtime,
  org: Org,
  view: Exclude<View, 'my'>,
  flags: ListFlags,
  groupId: string | undefined,
): Promise<Task[]> {
  const api = await runtime.api();
  const out: Task[] = [];
  let cursor: string | undefined;
  do {
    const page = await unwrap(
      api.GET('/api/v1/orgs/{orgId}/tasks', {
        params: {
          path: { orgId: org.id },
          query: {
            view,
            limit: PAGE,
            completed: flags.completed ? 'any' : 'false',
            ...(groupId === undefined ? {} : { groupId }),
            ...(flags.tags.length === 0 ? {} : { tag: flags.tags }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
      }),
    );
    out.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return out;
}

function sortGroups(groups: readonly Group[]): Group[] {
  return [...groups].sort(
    (a, b) =>
      (a.kind === 'inbox' ? 0 : 1) - (b.kind === 'inbox' ? 0 : 1) ||
      compareKeys(a.position, b.position) ||
      compareKeys(a.id, b.id),
  );
}

function bySubtaskPosition(a: Task, b: Task): number {
  return compareKeys(a.subtaskPosition ?? '', b.subtaskPosition ?? '') || compareKeys(a.id, b.id);
}

/** Tag names → ids (case-insensitive); an unknown name matches nothing (ADR 0007 §13). */
async function tagFilter(runtime: Runtime, orgId: string, names: readonly string[]) {
  if (names.length === 0) return null;
  const tags = await runtime.tags(orgId);
  return names.map(
    (name) =>
      tags.find((tag) => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())?.id ?? null,
  );
}

/** My tasks: the my-list payload, filtered like the query route, grouped by group. */
async function listMy(runtime: Runtime, org: Org, flags: ListFlags): Promise<OrgResult> {
  const list = await runtime.myList(org.id, flags.completed);
  const groupId =
    flags.group === undefined ? undefined : (await findGroup(runtime, org.id, flags.group)).id;
  const wanted = await tagFilter(runtime, org.id, flags.tags);
  const byId = new Map(list.tasks.map((task) => [task.id, task]));
  const placedGroup = (task: Task): string | null => {
    const seen = new Set<string>();
    let current: Task | undefined = task;
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.placement !== null) return current.placement.groupId;
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    return null;
  };
  const keep = (task: Task) =>
    (flags.completed || task.completedAt === null) &&
    (groupId === undefined || placedGroup(task) === groupId) &&
    (wanted === null || wanted.every((id) => id !== null && task.tagIds.includes(id)));
  const placed = list.tasks.filter((task) => task.placement !== null && keep(task));
  const children = new Map<string, Task[]>();
  if (flags.subtasks) {
    for (const task of list.tasks) {
      if (task.placement !== null || task.parentId === null || !keep(task)) continue;
      const siblings = children.get(task.parentId) ?? [];
      siblings.push(task);
      children.set(task.parentId, siblings);
    }
  }
  const groups = sortGroups(list.groups).filter((g) => groupId === undefined || g.id === groupId);
  const tasks: Task[] = [];
  const sections: Section[] = groups.flatMap((group) => {
    const rows: Section['rows'] = [];
    const addWithChildren = (task: Task, depth: number) => {
      rows.push({ task, depth });
      tasks.push(task);
      for (const child of (children.get(task.id) ?? []).sort(bySubtaskPosition)) {
        addWithChildren(child, depth + 1);
      }
    };
    placed
      .filter((task) => task.placement?.groupId === group.id)
      .sort(
        (a, b) =>
          compareKeys(a.placement?.position ?? '', b.placement?.position ?? '') ||
          compareKeys(a.id, b.id),
      )
      .forEach((task) => {
        addWithChildren(task, 0);
      });
    if (rows.length === 0 && groupId === undefined) return [];
    return [{ title: clean(group.name), rows }];
  });
  return { org, view: 'my', groups, tasks, sections };
}

/**
 * The rows of a view without `--subtasks`. A subtask shows only through its parent's ▸
 * progress when both are in the view and share an assignee; one assigned to someone else is
 * a row of its own (D-05, Everyone's tasks), and so is one whose parent is not in the view.
 */
export function viewRows<T extends Pick<Task, 'id' | 'parentId' | 'assigneeId'>>(
  tasks: readonly T[],
): T[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.filter((task) => {
    if (task.parentId === null) return true;
    const parent = byId.get(task.parentId);
    return parent === undefined || parent.assigneeId !== task.assigneeId;
  });
}

/** A smart view or Everyone's tasks, sectioned like the web (02 §10). */
async function listView(
  runtime: Runtime,
  org: Org,
  view: Exclude<View, 'my'>,
  flags: ListFlags,
  ctx: DateContext,
): Promise<OrgResult> {
  if (view === 'everyone' && org.isPersonal) {
    throw new CliError(EXIT.conflict, t('ls.everyonePersonal'));
  }
  if (view === 'everyone' && flags.group !== undefined) {
    throw new CliError(EXIT.usage, t('ls.groupNotEveryone'));
  }
  const groupId =
    flags.group === undefined ? undefined : (await findGroup(runtime, org.id, flags.group)).id;
  const all = await queryTasks(runtime, org, view, flags, groupId);
  const byId = new Map(all.map((task) => [task.id, task]));
  const tasks = flags.subtasks ? all : viewRows(all);
  const members =
    view === 'everyone' ? new Map((await runtime.members(org.id)).map((m) => [m.userId, m])) : null;
  const row = (task: Task) => {
    const parent = task.parentId === null ? undefined : byId.get(task.parentId);
    const assignee =
      members === null
        ? undefined
        : task.assigneeId === null
          ? t('ls.unassigned')
          : (members.get(task.assigneeId)?.name ?? '?');
    return {
      task,
      depth: 0,
      ...(parent === undefined ? {} : { breadcrumb: parent.title }),
      ...(assignee === undefined ? {} : { extra: `@${clean(assignee)}` }),
    };
  };
  const due = { today: ctx.today, nowMs: ctx.nowMs, viewerTz: ctx.timezone };
  let sections: Section[];
  if (view === 'today') {
    const overdue = tasks.filter((task) => inSmartView(task, 'overdue', due));
    const today = tasks.filter((task) => !overdue.includes(task));
    sections = [
      { title: t('view.overdue'), rows: overdue.map(row) },
      { title: t('view.today'), rows: today.map(row) },
    ].filter((s) => s.rows.length > 0);
  } else if (view === 'week') {
    const days = new Map<string, Section>();
    for (const task of tasks) {
      const date = task.dueDate ?? '';
      let section = days.get(date);
      if (section === undefined) {
        section = { title: dayLabel(date, ctx), rows: [] };
        days.set(date, section);
      }
      section.rows.push(row(task));
    }
    sections = [...days.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, s]) => s);
  } else {
    sections = tasks.length === 0 ? [] : [{ title: t(`view.${view}`), rows: tasks.map(row) }];
  }
  return { org, view, groups: null, tasks, sections };
}

export async function runList(runtime: Runtime, view: View, flags: ListFlags): Promise<void> {
  needs('tasks:read');
  const { out } = runtime;
  const ctx = await dates(runtime);
  const me = await runtime.me();
  const orgs = flags.allOrgs
    ? me.orgs.filter((o) => view !== 'everyone' || !o.isPersonal)
    : [await runtime.org()];
  const results: OrgResult[] = [];
  for (const org of orgs) {
    results.push(
      view === 'my'
        ? await listMy(runtime, org, flags)
        : await listView(runtime, org, view, flags, ctx),
    );
  }

  if (out.json) {
    if (view === 'my') {
      const payload = results.map((r) => ({
        org: r.org.slug,
        groups: r.groups ?? [],
        tasks: r.tasks,
      }));
      out.data(
        flags.allOrgs
          ? payload
          : { groups: payload[0]?.groups ?? [], tasks: payload[0]?.tasks ?? [] },
      );
    } else {
      out.data(results.flatMap((r) => r.tasks));
    }
    return;
  }
  if (out.quiet) {
    for (const r of results) {
      for (const task of r.tasks) out.line(taskRef(task, flags.allOrgs ? r.org.slug : undefined));
    }
    return;
  }

  // One set of column widths for the whole listing, so every section lines up.
  const rendered: { result: OrgResult; section: Section; rows: Row[] }[] = [];
  for (const result of results) {
    const tags = await tagMap(runtime, result.org.id);
    for (const section of result.sections) {
      rendered.push({
        result,
        section,
        rows: section.rows.map((r) =>
          toRow(r.task, {
            tags,
            dates: ctx,
            depth: r.depth,
            ...(flags.allOrgs ? { orgSlug: result.org.slug } : {}),
            ...(r.breadcrumb === undefined ? {} : { breadcrumb: r.breadcrumb }),
            ...(r.extra === undefined ? {} : { extra: r.extra }),
          }),
        ),
      });
    }
  }
  const lines = renderRows(
    rendered.flatMap((r) => r.rows),
    out.level,
    out.columns,
  );
  let index = 0;
  let first = true;
  for (const result of results) {
    if (!first) out.line();
    first = false;
    out.line(
      paint(`${clean(result.org.name)} · ${t(`view.${result.view}`)}`, styles.heading, out.level),
    );
    const blocks = rendered.filter((r) => r.result === result);
    if (blocks.length === 0) out.line(paint(`  ${t('ls.empty')}`, styles.muted, out.level));
    for (const block of blocks) {
      const topLevel = block.section.rows.filter((r) => r.depth === 0).length;
      out.line(header(block.section.title, topLevel, out.level));
      for (let i = 0; i < block.rows.length; i++) out.line(lines[index++]);
    }
  }
}

function describeListArgs() {
  return {
    view: { type: 'positional', required: false, description: t('ls.arg.view') },
    group: { type: 'string', valueHint: 'name', description: t('ls.arg.group') },
    tag: { type: 'string', valueHint: 'tag', description: t('ls.arg.tag') },
    completed: { type: 'boolean', description: t('ls.arg.completed') },
    'all-orgs': { type: 'boolean', description: t('ls.arg.allOrgs') },
    subtasks: { type: 'boolean', description: t('ls.arg.subtasks') },
  } as const;
}

function flagsOf(args: Record<string, unknown>, rawArgs: readonly string[]): ListFlags {
  return {
    group: typeof args.group === 'string' && args.group !== '' ? args.group : undefined,
    tags: multi(rawArgs, 'tag').map((tag) => tag.replace(/^#/, '')),
    completed: args.completed === true,
    allOrgs: args['all-orgs'] === true || args.allOrgs === true,
    subtasks: args.subtasks === true,
  };
}

export function parseView(value: string | undefined): View {
  const view = (value ?? 'my') as View;
  if (!VIEWS.includes(view))
    throw new CliError(EXIT.usage, t('ls.badView', { view: value, views: VIEWS.join(', ') }));
  return view;
}

export const lsCommand = defineCommand({
  meta: () => ({ name: 'ls', description: t('cmd.ls') }),
  args: describeListArgs,
  async run({ args, rawArgs }) {
    const [view, ...extra] = positionals(args);
    if (extra.length > 0) throw new CliError(EXIT.usage, t('usage.unexpected', { arg: extra[0] }));
    await runList(rt(), parseView(view), flagsOf(args, rawArgs));
  },
});

function viewAlias(view: 'today' | 'week') {
  return defineCommand({
    meta: () => ({ name: view, description: t(`cmd.${view}`) }),
    args: () => {
      const { view: _positional, ...others } = describeListArgs();
      return others;
    },
    async run({ args, rawArgs }) {
      await runList(rt(), view, flagsOf(args, rawArgs));
    },
  });
}

export const todayCommand = viewAlias('today');
export const weekCommand = viewAlias('week');
