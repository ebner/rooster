import { compareKeys } from '@rooster/core/ordering';
import { defineCommand } from 'citty';
import { type Group, unwrap } from '../api.ts';
import { CliError, EXIT } from '../errors.ts';
import { findGroup } from '../grant-info.ts';
import { t } from '../i18n.ts';
import { clean, paint } from '../output/color.ts';
import { styles } from '../output/theme.ts';
import { type Runtime, rt } from '../runtime.ts';
import { confirmOrAbort, needs, positionals } from './util.ts';

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

function ordered(groups: readonly Group[]): Group[] {
  return [...groups].sort(
    (a, b) =>
      (a.kind === 'inbox' ? 0 : 1) - (b.kind === 'inbox' ? 0 : 1) ||
      compareKeys(a.position, b.position) ||
      compareKeys(a.id, b.id),
  );
}

/** The group directly below `group` in my list (for `--after`), or null at the end. */
function nextAfter(groups: readonly Group[], group: Group): Group | null {
  const list = ordered(groups);
  return list[list.findIndex((g) => g.id === group.id) + 1] ?? null;
}

function previousBefore(groups: readonly Group[], group: Group): Group | null {
  const list = ordered(groups);
  const index = list.findIndex((g) => g.id === group.id);
  const above = list[index - 1];
  return above === undefined || above.kind === 'inbox' ? null : above;
}

function printGroup(runtime: Runtime, group: Group, count?: number): void {
  const { out } = runtime;
  if (out.json) out.data(group);
  else if (out.quiet) out.line(group.id);
  else {
    const suffix = count === undefined ? '' : ` ${paint(`(${count})`, styles.muted, out.level)}`;
    out.line(`${clean(group.name)}${suffix}`);
  }
}

const ls = defineCommand({
  meta: () => ({ name: 'ls', description: t('group.cmd.ls') }),
  async run() {
    const runtime = needs('tasks:read');
    const org = await runtime.org();
    const list = await runtime.myList(org.id);
    const groups = ordered(list.groups);
    const { out } = runtime;
    if (out.json) {
      out.data(groups);
      return;
    }
    for (const group of groups) {
      if (out.quiet) {
        out.line(group.id);
        continue;
      }
      const open = list.tasks.filter(
        (task) => task.placement?.groupId === group.id && task.completedAt === null,
      ).length;
      const name = paint(
        clean(group.name),
        group.kind === 'inbox' ? styles.accent : styles.heading,
        out.level,
      );
      out.line(`${name} ${paint(`(${open})`, styles.muted, out.level)}`);
    }
  },
});

const add = defineCommand({
  meta: () => ({ name: 'add', description: t('group.cmd.add') }),
  args: () => ({
    name: { type: 'positional', required: true, description: t('group.arg.name') },
    after: { type: 'string', valueHint: 'name', description: t('group.arg.after') },
  }),
  async run({ args }) {
    const runtime = needs('groups:write');
    const name = positionals(args).join(' ').trim();
    if (name === '') throw new CliError(EXIT.usage, t('group.nameMissing'));
    const org = await runtime.org();
    const afterName = str(args.after);
    const groups = await runtime.groups(org.id);
    const after = afterName === undefined ? undefined : await findGroup(runtime, org.id, afterName);
    const intent =
      after === undefined
        ? {}
        : after.kind === 'inbox'
          ? { afterId: null, beforeId: ordered(groups).find((g) => g.kind !== 'inbox')?.id ?? null }
          : { afterId: after.id, beforeId: nextAfter(groups, after)?.id ?? null };
    const result = await unwrap(
      (await runtime.api()).POST('/api/v1/orgs/{orgId}/groups', {
        params: { path: { orgId: org.id } },
        body: { name, ...intent },
      }),
    );
    printGroup(runtime, result.group);
  },
});

const rename = defineCommand({
  meta: () => ({ name: 'rename', description: t('group.cmd.rename') }),
  args: () => ({
    name: { type: 'positional', required: true, description: t('group.arg.name') },
    newName: { type: 'positional', required: true, description: t('group.arg.newName') },
  }),
  async run({ args }) {
    const runtime = needs('groups:write');
    const [name, ...rest] = positionals(args);
    const newName = rest.join(' ').trim();
    if (name === undefined || newName === '')
      throw new CliError(EXIT.usage, t('group.nameMissing'));
    const org = await runtime.org();
    const group = await findGroup(runtime, org.id, name);
    const updated = await unwrap(
      (await runtime.api()).PATCH('/api/v1/groups/{id}', {
        params: { path: { id: group.id } },
        body: { name: newName },
      }),
    );
    printGroup(runtime, updated);
  },
});

const mv = defineCommand({
  meta: () => ({ name: 'mv', description: t('group.cmd.mv') }),
  args: () => ({
    name: { type: 'positional', required: true, description: t('group.arg.name') },
    after: { type: 'string', valueHint: 'name', description: t('group.arg.after') },
    before: { type: 'string', valueHint: 'name', description: t('group.arg.before') },
  }),
  async run({ args }) {
    const runtime = needs('groups:write');
    const name = positionals(args).join(' ').trim();
    const org = await runtime.org();
    const group = await findGroup(runtime, org.id, name);
    const groups = (await runtime.groups(org.id)).filter((g) => g.id !== group.id);
    const afterName = str(args.after);
    const beforeName = str(args.before);
    let intent: { afterId: string | null; beforeId: string | null };
    if (afterName !== undefined) {
      const after = await findGroup(runtime, org.id, afterName);
      const below = nextAfter(groups, after);
      intent =
        after.kind === 'inbox'
          ? { afterId: null, beforeId: below?.id ?? null }
          : { afterId: after.id, beforeId: below?.id ?? null };
    } else if (beforeName !== undefined) {
      const before = await findGroup(runtime, org.id, beforeName);
      intent = { afterId: previousBefore(groups, before)?.id ?? null, beforeId: before.id };
    } else {
      throw new CliError(EXIT.usage, t('group.mvNeedsTarget'));
    }
    await unwrap(
      (await runtime.api()).POST('/api/v1/groups/{id}/move', {
        params: { path: { id: group.id } },
        body: intent,
      }),
    );
    printGroup(runtime, group);
  },
});

const rm = defineCommand({
  meta: () => ({ name: 'rm', description: t('group.cmd.rm') }),
  args: () => ({
    name: { type: 'positional', required: true, description: t('group.arg.name') },
    'move-to': { type: 'string', valueHint: 'name', description: t('group.arg.moveTo') },
    'delete-tasks': { type: 'boolean', description: t('group.arg.deleteTasks') },
  }),
  async run({ args }) {
    const runtime = rt();
    const name = positionals(args).join(' ').trim();
    const org = await runtime.org();
    const group = await findGroup(runtime, org.id, name);
    const moveTo = str(args['move-to']);
    const deleteTasks = args['delete-tasks'] === true;
    if (moveTo !== undefined && deleteTasks) throw new CliError(EXIT.usage, t('group.rmBoth'));
    needs(deleteTasks ? 'tasks:delete' : 'groups:write');
    const list = await runtime.myList(org.id);
    const count = list.tasks.filter((task) => task.placement?.groupId === group.id).length;
    if (count > 0 && moveTo === undefined && !deleteTasks) {
      throw new CliError(EXIT.conflict, t('group.notEmpty', { name: clean(group.name), count }));
    }
    if (deleteTasks && count > 0) {
      await confirmOrAbort(runtime, t('group.confirmDelete', { name: clean(group.name), count }));
    }
    const target = moveTo === undefined ? undefined : await findGroup(runtime, org.id, moveTo);
    await unwrap(
      (await runtime.api()).DELETE('/api/v1/groups/{id}', {
        params: { path: { id: group.id } },
        body:
          count === 0
            ? {}
            : target !== undefined
              ? { moveTasksTo: target.id }
              : { deleteTasks: true },
      }),
    );
    if (runtime.out.json) runtime.out.data({ id: group.id, deleted: true });
    else runtime.out.notice(t('group.deleted', { name: clean(group.name) }));
  },
});

export const groupCommand = defineCommand({
  meta: () => ({ name: 'group', description: t('cmd.group') }),
  subCommands: { ls, add, rename, mv, rm },
});
