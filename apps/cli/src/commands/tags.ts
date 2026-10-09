import { tagColorNames } from '@rooster/tokens';
import { type ArgsDef, type CommandDef, defineCommand, runCommand } from 'citty';
import { type Tag, unwrap } from '../api.ts';
import { CliError, EXIT } from '../errors.ts';
import { t } from '../i18n.ts';
import { clean, paint } from '../output/color.ts';
import { tagStyle } from '../output/theme.ts';
import { resolveRef } from '../refs.ts';
import { type Runtime, rt } from '../runtime.ts';
import { needs, positionals, printTasks } from './util.ts';

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

async function findTag(runtime: Runtime, orgId: string, name: string): Promise<Tag | undefined> {
  const wanted = name.replace(/^#/, '').toLocaleLowerCase();
  return (await runtime.tags(orgId)).find((tag) => tag.name.toLocaleLowerCase() === wanted);
}

function printTag(runtime: Runtime, tag: Tag): void {
  const { out } = runtime;
  if (out.json) out.data(tag);
  else if (out.quiet) out.line(tag.id);
  else out.line(paint(`#${clean(tag.name)}`, tagStyle(tag.color), out.level));
}

const ls = defineCommand({
  meta: () => ({ name: 'ls', description: t('tag.cmd.ls') }),
  async run() {
    const runtime = needs('tasks:read');
    const org = await runtime.org();
    const tags = await runtime.tags(org.id);
    if (runtime.out.json) {
      runtime.out.data(tags);
      return;
    }
    for (const tag of tags) printTag(runtime, tag);
  },
});

const add = defineCommand({
  meta: () => ({ name: 'add', description: t('tag.cmd.add') }),
  args: () => ({
    name: { type: 'positional', required: true, description: t('tag.arg.name') },
    color: {
      type: 'enum',
      options: [...tagColorNames],
      valueHint: tagColorNames.join('|'),
      description: t('tag.arg.color'),
    },
  }),
  async run({ args }) {
    const runtime = needs('tasks:write');
    const name = (positionals(args)[0] ?? '').replace(/^#/, '').trim();
    if (name === '') throw new CliError(EXIT.usage, t('tag.nameMissing'));
    const org = await runtime.org();
    const color = str(args.color) as Tag['color'] | undefined;
    const tag = await unwrap(
      (await runtime.api()).POST('/api/v1/orgs/{orgId}/tags', {
        params: { path: { orgId: org.id } },
        body: { name, ...(color === undefined ? {} : { color }) },
      }),
    );
    printTag(runtime, tag);
  },
});

const rm = defineCommand({
  meta: () => ({ name: 'rm', description: t('tag.cmd.rm') }),
  args: () => ({ name: { type: 'positional', required: true, description: t('tag.arg.name') } }),
  async run({ args }) {
    const runtime = needs('tasks:write');
    const name = positionals(args)[0] ?? '';
    const org = await runtime.org();
    const tag = await findTag(runtime, org.id, name);
    if (tag === undefined) throw new CliError(EXIT.notFound, t('tag.notFound', { name }));
    await unwrap(
      (await runtime.api()).DELETE('/api/v1/tags/{id}', { params: { path: { id: tag.id } } }),
    );
    if (runtime.out.json) runtime.out.data({ id: tag.id, deleted: true });
    else runtime.out.notice(t('tag.deleted', { name: clean(tag.name) }));
  },
});

/**
 * `rooster tag <ref> +urgent -later`: tags the task (unknown `+` names are created, like the
 * web's picker) and untags it; set semantics, so repeating it is harmless.
 */
export async function retag(runtime: Runtime, ref: string, changes: readonly string[]) {
  needs('tasks:write');
  if (changes.length === 0) throw new CliError(EXIT.usage, t('tag.changesMissing'));
  const task = await resolveRef(runtime, ref);
  const api = await runtime.api();
  for (const change of changes) {
    const sign = change[0];
    const name = change.slice(1).replace(/^#/, '');
    if ((sign !== '+' && sign !== '-') || name === '') {
      throw new CliError(EXIT.usage, t('tag.badChange', { change }));
    }
    let tag = await findTag(runtime, task.orgId, name);
    if (sign === '+') {
      if (tag === undefined) {
        tag = await unwrap(
          api.POST('/api/v1/orgs/{orgId}/tags', {
            params: { path: { orgId: task.orgId } },
            body: { name },
          }),
        );
        runtime.forgetTags(task.orgId);
      }
      await unwrap(
        api.PUT('/api/v1/tasks/{id}/tags/{tagId}', {
          params: { path: { id: task.id, tagId: tag.id } },
        }),
      );
    } else if (tag !== undefined) {
      await unwrap(
        api.DELETE('/api/v1/tasks/{id}/tags/{tagId}', {
          params: { path: { id: task.id, tagId: tag.id } },
        }),
      );
    }
  }
  const updated = await unwrap(
    api.GET('/api/v1/tasks/{id}', { params: { path: { id: task.id } } }),
  );
  await printTasks(runtime, [updated]);
}

const SUBCOMMANDS = { ls, add, rm } as const;

/**
 * `tag ls|add|rm` manages tags; any other first argument is a task ref followed by
 * `+name`/`-name` changes. Parsed by hand because `-later` would read as a flag.
 */
export const tagCommand = defineCommand({
  meta: () => ({ name: 'tag', description: t('cmd.tag') }),
  args: () => ({
    action: { type: 'positional', required: true, description: t('tag.arg.action') },
  }),
  async run({ rawArgs }) {
    const [first, ...rest] = rawArgs;
    if (first !== undefined && first in SUBCOMMANDS) {
      await runCommand(SUBCOMMANDS[first as keyof typeof SUBCOMMANDS] as CommandDef<ArgsDef>, {
        rawArgs: rest,
      });
      return;
    }
    if (first === undefined) throw new CliError(EXIT.usage, t('tag.changesMissing'));
    await retag(rt(), first, rest);
  },
});

export const tagSubCommands = SUBCOMMANDS;
