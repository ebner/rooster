import { defineCommand } from 'citty';
import type { Org, Task } from '../api.ts';
import { CliError, EXIT } from '../errors.ts';
import { currentLocale, t } from '../i18n.ts';
import { clean, displayWidth, paint } from '../output/color.ts';
import { header, padCell, renderRows, taskRef, toRow } from '../output/format.ts';
import { styles } from '../output/theme.ts';
import type { Runtime } from '../runtime.ts';
import {
  fetchViews,
  fetchViewTasks,
  type SavedView,
  viewCounts,
  viewIcon,
  viewSections,
} from '../saved-views.ts';
import { dates, needs, tagMap } from './util.ts';

/**
 * Phase 13 (ADR 0073 B12): `rooster view ls` lists the org's views in my order, and
 * `rooster ls --view <name|id>` a view's rows, grouped by person as on the web (B4).
 */

/** The view a `--view` value names: an ID, else its name (any case) among the live views. */
export async function resolveView(runtime: Runtime, org: Org, ref: string): Promise<SavedView> {
  const api = await runtime.api();
  const live = await fetchViews(api, org.id);
  const wanted = ref.trim();
  const byId = live.find((view) => view.id === wanted);
  if (byId !== undefined) return byId;
  const folded = (name: string) => name.toLocaleLowerCase(currentLocale());
  const named = (text: string) => live.filter((view) => folded(view.name) === folded(text));
  let matches = named(wanted);
  // `#juniper` names the project view "Juniper" as `--tag #juniper` names the tag.
  if (matches.length === 0 && wanted.startsWith('#')) matches = named(wanted.slice(1));
  const [only] = matches;
  if (only !== undefined && matches.length === 1) return only;
  if (matches.length > 1) {
    throw new CliError(
      EXIT.notFound,
      t('views.ambiguous', {
        name: clean(wanted),
        candidates: matches
          .map((view) => `${clean(view.id)} (${t(view.shared ? 'views.shared' : 'views.private')})`)
          .join(', '),
      }),
    );
  }
  // An archived view is reached by its ID (`rooster view ls --archived` lists them).
  const archived = await fetchViews(api, org.id, { archived: true });
  const old = archived.find((view) => view.id === wanted);
  if (old !== undefined) return old;
  throw new CliError(
    EXIT.notFound,
    live.length === 0
      ? t('views.notFoundNone', { name: clean(wanted), org: clean(org.name) })
      : t('views.notFound', {
          name: clean(wanted),
          org: clean(org.name),
          views: live.map((view) => clean(view.name)).join(', '),
        }),
  );
}

/** One `view ls` line: icon, name, shared or private, and the open count (B9). */
function viewLines(runtime: Runtime, views: readonly SavedView[]): string[] {
  const { out } = runtime;
  const names = views.map((view) => clean(view.name).replace(/\s+/g, ' '));
  const scopes = views.map((view) => t(view.shared ? 'views.shared' : 'views.private'));
  const nameW = Math.max(0, ...names.map(displayWidth));
  const scopeW = Math.max(0, ...scopes.map(displayWidth));
  return views.map((view, i) => {
    const open = Number.isSafeInteger(view.openCount) && view.openCount >= 0 ? view.openCount : 0;
    return [
      paint(viewIcon(view), styles.accent, out.level),
      padCell(names[i] ?? '', nameW),
      paint(padCell(scopes[i] ?? '', scopeW), styles.muted, out.level),
      paint(t('views.open', { count: open }), styles.muted, out.level),
    ]
      .join('  ')
      .trimEnd();
  });
}

const ls = defineCommand({
  meta: () => ({ name: 'ls', description: t('views.cmd.ls') }),
  args: () => ({ archived: { type: 'boolean', description: t('views.arg.archived') } }),
  async run({ args }) {
    const runtime = needs('tasks:read');
    const org = await runtime.org();
    const archived = args.archived === true;
    const views = await fetchViews(await runtime.api(), org.id, { archived });
    const { out } = runtime;
    if (out.json) {
      out.data(views);
      return;
    }
    if (out.quiet) {
      for (const view of views) out.line(clean(view.id));
      return;
    }
    out.line(
      paint(
        `${clean(org.name)} · ${t(archived ? 'views.archivedTitle' : 'views.title')}`,
        styles.heading,
        out.level,
      ),
    );
    if (views.length === 0) {
      out.line(
        paint(`  ${t(archived ? 'views.noneArchived' : 'views.none')}`, styles.muted, out.level),
      );
      return;
    }
    for (const line of viewLines(runtime, views)) out.line(line);
  },
});

export const viewCommand = defineCommand({
  meta: () => ({ name: 'view', description: t('cmd.view') }),
  subCommands: { ls },
});

/**
 * `rooster ls --view <name|id>`: the view's rows by person (me, the members alphabetically, then
 * Unassigned; one section in a personal org), each by due date. `--completed` asks for the
 * completed matches too. `--json` is a flat array in display order.
 */
export async function runViewList(
  runtime: Runtime,
  ref: string,
  flags: { completed: boolean },
): Promise<void> {
  needs('tasks:read');
  const { out } = runtime;
  const ctx = await dates(runtime);
  const me = await runtime.me();
  const org = await runtime.org();
  const view = await resolveView(runtime, org, ref);
  const result = await fetchViewTasks(await runtime.api(), view.id, flags.completed);
  const members = org.isPersonal ? [] : await runtime.members(org.id);
  const byId = new Map(result.items.map((task) => [task.id, task]));
  const sections = viewSections({
    view,
    tasks: result.items,
    viewerId: me.id,
    due: { today: ctx.today, nowMs: ctx.nowMs, viewerTz: ctx.timezone },
    members,
    // The user's own language, as the web sorts the people (not the CLI's, which may differ).
    locale: me.locale,
    isPersonal: org.isPersonal,
    showCompleted: flags.completed,
  })
    .map((section) => ({
      assigneeId: section.assigneeId,
      tasks: section.taskIds
        .map((id) => byId.get(id))
        .filter((task): task is Task => task !== undefined),
    }))
    // The web keeps empty person sections for their inline add; a listing leaves them out.
    .filter((section) => section.tasks.length > 0);
  const tasks = sections.flatMap((section) => section.tasks);

  if (out.json) {
    out.data(tasks);
    return;
  }
  if (out.quiet) {
    for (const task of tasks) out.line(taskRef(task));
    return;
  }
  const names = new Map(members.map((m) => [m.userId, m.name]));
  const title = (assigneeId: string | null) => {
    if (assigneeId === null) return t('ls.unassigned');
    const known = names.get(assigneeId) ?? (assigneeId === me.id ? me.name : undefined);
    if (known === undefined) return t('views.formerMember');
    const name = clean(known);
    return assigneeId === me.id ? t('views.you', { name }) : name;
  };
  const tags = await tagMap(runtime, org.id);
  const rows = tasks.map((task) => {
    const parent = task.parentId === null ? undefined : byId.get(task.parentId);
    return toRow(task, {
      tags,
      dates: ctx,
      ...(parent === undefined ? {} : { breadcrumb: parent.title }),
    });
  });
  const lines = renderRows(rows, out.level, out.columns);
  const counts = viewCounts(result);
  const heading = paint(`${clean(org.name)} · ${clean(view.name)}`, styles.heading, out.level);
  // A project view's header says how far along it is (B3).
  out.line(
    viewIcon(view) === '#' && counts !== null
      ? `${heading}  ${paint(t('views.counts', counts), styles.muted, out.level)}`
      : heading,
  );
  if (tasks.length === 0) out.line(paint(`  ${t('ls.empty')}`, styles.muted, out.level));
  let index = 0;
  for (const section of sections) {
    // A personal org has one section, the viewer's, and no person headers (B4).
    if (!org.isPersonal)
      out.line(header(title(section.assigneeId), section.tasks.length, out.level));
    for (let i = 0; i < section.tasks.length; i++) out.line(lines[index++] ?? '');
  }
}
