import { readFileSync } from 'node:fs';
import { findGroupToken, matchMembers } from '@rooster/core/dates';
import { defineCommand } from 'citty';
import { type Org, type RoosterClient, type Task, type TaskDetail, unwrap } from '../api.ts';
import { applyDueFlags, type DueFlags, isNone } from '../dates.ts';
import { editText } from '../editor.ts';
import { CliError, EXIT } from '../errors.ts';
import { findGroup } from '../grant-info.ts';
import { t } from '../i18n.ts';
import { clean, paint } from '../output/color.ts';
import { renderRows, toRow } from '../output/format.ts';
import { renderMarkdown } from '../output/markdown.ts';
import { styles } from '../output/theme.ts';
import { rememberLast, resolveRef, resolveRefs } from '../refs.ts';
import { type Runtime, rt } from '../runtime.ts';
import { openInBrowser } from './browser.ts';
import { confirmOrAbort, dates, multi, needs, positionals, printTasks, tagMap } from './util.ts';

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** `--assign me|none|<email>|<name>` → a member of the org (null = unassigned). */
export async function resolveAssignee(
  runtime: Runtime,
  orgId: string,
  input: string,
): Promise<string | null> {
  const me = await runtime.me();
  const query = input.trim();
  if (isNone(query)) return null;
  if (query === 'me' || query === 'mig') return me.id;
  const members = await runtime.members(orgId);
  if (query.includes('@')) {
    const byEmail = members.find((m) => m.email.toLowerCase() === query.toLowerCase());
    if (byEmail) return byEmail.userId;
  }
  const matches = matchMembers(query, members, me.id);
  const exact = matches.filter((m) => m.exact);
  const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
  if (pick !== undefined) return pick.userId;
  if (matches.length > 1) {
    const names = matches
      .map((m) => members.find((x) => x.userId === m.userId)?.name ?? m.userId)
      .join(', ');
    throw new CliError(EXIT.notFound, t('member.ambiguous', { query, names }));
  }
  throw new CliError(EXIT.notFound, t('member.notFound', { query }));
}

async function readDescription(runtime: Runtime, desc: unknown, file: unknown) {
  const path = str(file);
  if (path !== undefined) {
    if (path === '-') return runtime.io.readStdin();
    try {
      return readFileSync(path, 'utf8');
    } catch {
      throw new CliError(EXIT.usage, t('task.descFileUnreadable', { path }));
    }
  }
  return typeof desc === 'string' ? desc : undefined;
}

/** The first task (open or completed) of one of my groups, for "top of the group". */
async function firstInGroup(api: RoosterClient, orgId: string, groupId: string, skip?: string) {
  const page = await unwrap(
    api.GET('/api/v1/orgs/{orgId}/tasks', {
      params: { path: { orgId }, query: { groupId, completed: 'any', limit: 2 } },
    }),
  );
  return page.items.find((task) => task.id !== skip) ?? null;
}

interface CreateOptions {
  title: string;
  parent?: Task;
  args: Record<string, unknown>;
  rawArgs: readonly string[];
}

/** `add` and `sub` (07 §4): the title is NL-parsed server-side unless `--no-parse`. */
async function createTask(runtime: Runtime, options: CreateOptions): Promise<void> {
  const { args, rawArgs, parent } = options;
  const title = options.title.trim();
  if (title === '') throw new CliError(EXIT.usage, t('task.titleMissing'));
  const org: Org =
    parent === undefined
      ? await runtime.org()
      : ((await runtime.orgById(parent.orgId)) ?? (await runtime.org()));
  const me = await runtime.me();
  const api = await runtime.api();
  const assign = str(args.assign);
  const assigneeId =
    assign === undefined ? undefined : await resolveAssignee(runtime, org.id, assign);
  needs(assigneeId !== undefined && assigneeId !== me.id ? 'tasks:assign' : 'tasks:write');

  const due = applyDueFlags(
    { dueDate: null, dueTime: null, dueTz: null, startDate: null },
    { due: str(args.due), time: str(args.time), start: str(args.start) },
    me,
    runtime.io.now(),
  );
  const description = await readDescription(runtime, args.desc, args['desc-file']);
  const tagNames = multi(rawArgs, 'tag').map((tag) => tag.replace(/^#/, ''));
  const bottom = args.bottom === true;
  const groupName = str(args.group);
  const group = groupName === undefined ? undefined : await findGroup(runtime, org.id, groupName);

  let intent: { afterId?: string | null; beforeId?: string | null } = {};
  if (parent === undefined && bottom) intent = { afterId: null, beforeId: null };
  else if (parent === undefined && group !== undefined) {
    const first = await firstInGroup(api, org.id, group.id);
    intent = first === null ? {} : { afterId: null, beforeId: first.id };
  }

  const created = await unwrap(
    api.POST('/api/v1/orgs/{orgId}/tasks', {
      params: { path: { orgId: org.id } },
      body: {
        title,
        parse: args.parse !== false,
        ...(due === null ? {} : due),
        ...(description === undefined ? {} : { description }),
        ...(group === undefined ? {} : { groupId: group.id }),
        ...(parent === undefined ? {} : { parentId: parent.id }),
        ...(tagNames.length === 0 ? {} : { tagNames }),
        ...(assigneeId === undefined ? {} : { assigneeId }),
        ...intent,
      },
    }),
  );

  // A `>Group` token picks the group server-side, where a create without an intent lands at
  // the group's end; the CLI's default is the top (07 §4), so move it there.
  let task = created;
  const parsedGroup =
    parent === undefined &&
    group === undefined &&
    !bottom &&
    args.parse !== false &&
    findGroupToken(title) !== null &&
    created.placement !== null;
  if (parsedGroup && created.placement !== null) {
    const groups = await runtime.groups(org.id);
    const target = groups.find((g) => g.id === created.placement?.groupId);
    if (target !== undefined && target.kind !== 'inbox') {
      const first = await firstInGroup(api, org.id, target.id, created.id);
      if (first !== null) {
        const moved = await unwrap(
          api.POST('/api/v1/tasks/{id}/move', {
            params: { path: { id: created.id } },
            body: { groupId: target.id, afterId: null, beforeId: first.id },
          }),
        );
        task = { ...created, placement: moved.placement };
      }
    }
  }
  rememberLast(runtime, task);
  await printTasks(runtime, [task]);
}

const createArgs = () =>
  ({
    due: { type: 'string', valueHint: 'phrase|date', description: t('add.arg.due') },
    time: { type: 'string', valueHint: 'HH:MM', description: t('add.arg.time') },
    start: { type: 'string', valueHint: 'date', description: t('add.arg.start') },
    tag: { type: 'string', valueHint: 'tag', description: t('add.arg.tag') },
    assign: { type: 'string', valueHint: 'email|name|me', description: t('add.arg.assign') },
    desc: { type: 'string', valueHint: 'text', description: t('add.arg.desc') },
    'desc-file': { type: 'string', valueHint: 'path|-', description: t('add.arg.descFile') },
    parse: {
      type: 'boolean',
      default: true,
      description: t('add.arg.parse'),
      negativeDescription: t('add.arg.noParse'),
    },
  }) as const;

export const addCommand = defineCommand({
  meta: () => ({ name: 'add', description: t('cmd.add') }),
  args: () => ({
    title: { type: 'positional', required: true, description: t('add.arg.title') },
    ...createArgs(),
    group: { type: 'string', valueHint: 'name', description: t('add.arg.group') },
    top: { type: 'boolean', description: t('add.arg.top') },
    bottom: { type: 'boolean', description: t('add.arg.bottom') },
    parent: { type: 'string', valueHint: 'ref', description: t('add.arg.parent') },
  }),
  async run({ args, rawArgs }) {
    const runtime = rt();
    const parentRef = str(args.parent);
    const parent = parentRef === undefined ? undefined : await resolveRef(runtime, parentRef);
    await createTask(runtime, {
      title: positionals(args).join(' '),
      ...(parent === undefined ? {} : { parent }),
      args,
      rawArgs,
    });
  },
});

export const subCommand = defineCommand({
  meta: () => ({ name: 'sub', description: t('cmd.sub') }),
  args: () => ({
    parent: { type: 'positional', required: true, description: t('sub.arg.parent') },
    title: { type: 'positional', required: true, description: t('add.arg.title') },
    ...createArgs(),
  }),
  async run({ args, rawArgs }) {
    const runtime = rt();
    const [parentRef, ...words] = positionals(args);
    const parent = await resolveRef(runtime, parentRef ?? '');
    await createTask(runtime, { title: words.join(' '), parent, args, rawArgs });
  },
});

/**
 * The newest `max` comments, oldest first. The feed pages newest page first, each page in
 * chronological order, so earlier pages are prepended and paging stops once there are enough.
 */
async function recentComments(api: RoosterClient, taskId: string, max: number) {
  type Comment = { authorId: string; body: string; createdAt: number };
  const pages: Comment[][] = [];
  let count = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 10 && count < max; page++) {
    const result = await unwrap(
      api.GET('/api/v1/tasks/{id}/activity', {
        params: {
          path: { id: taskId },
          query: { filter: 'comments', limit: 100, ...(cursor === undefined ? {} : { cursor }) },
        },
      }),
    );
    const comments = result.items.flatMap((item) =>
      item.kind === 'comment' ? [item.comment] : [],
    );
    pages.unshift(comments);
    count += comments.length;
    cursor = result.nextCursor ?? undefined;
    if (cursor === undefined) break;
  }
  return pages.flat().slice(-max);
}

export const showCommand = defineCommand({
  meta: () => ({ name: 'show', description: t('cmd.show') }),
  args: () => ({ ref: { type: 'positional', required: true, description: t('arg.ref') } }),
  async run({ args }) {
    const runtime = needs('tasks:read');
    const { out } = runtime;
    const found = await resolveRef(runtime, positionals(args)[0] ?? '');
    const api = await runtime.api();
    const task: TaskDetail = await unwrap(
      api.GET('/api/v1/tasks/{id}', { params: { path: { id: found.id } } }),
    );
    if (out.json) {
      out.data(task);
      return;
    }
    if (out.quiet) {
      out.line(String(task.seq ?? task.id));
      return;
    }
    const ctx = await dates(runtime);
    const tags = await tagMap(runtime, task.orgId);
    const org = await runtime.orgById(task.orgId);
    const head = renderRows([toRow(task, { tags, dates: ctx })], out.level, out.columns);
    for (const line of head) out.line(line);

    const fields: [string, string][] = [];
    if (org !== undefined) fields.push([t('show.org'), `${clean(org.name)} (${clean(org.slug)})`]);
    if (task.placement !== null) {
      const group = (await runtime.groups(task.orgId)).find(
        (g) => g.id === task.placement?.groupId,
      );
      if (group !== undefined) fields.push([t('show.group'), clean(group.name)]);
    }
    if (task.parentChain.length > 0) {
      fields.push([t('show.parent'), task.parentChain.map((p) => clean(p.title)).join(' › ')]);
    }
    const label = toRow(task, { tags, dates: ctx }).due;
    if (label !== null && task.dueDate !== null) {
      const iso = [
        task.startDate ? `${task.startDate} – ` : '',
        task.dueDate,
        task.dueTime ? ` ${task.dueTime} ${task.dueTz ?? ''}` : '',
      ]
        .join('')
        .trim();
      fields.push([t('show.due'), `${label.text} (${iso})`]);
    }
    if (task.assigneeId !== null) {
      const me = await runtime.me();
      const name =
        task.assigneeId === me.id
          ? t('show.you')
          : ((await runtime.members(task.orgId).catch(() => [])).find(
              (m) => m.userId === task.assigneeId,
            )?.name ?? task.assigneeId);
      fields.push([t('show.assignee'), clean(name)]);
    } else fields.push([t('show.assignee'), t('ls.unassigned')]);
    if (task.tagIds.length > 0) {
      fields.push([
        t('show.tags'),
        task.tagIds.map((id) => `#${clean(tags.get(id)?.name ?? id)}`).join(' '),
      ]);
    }
    fields.push([t('show.id'), task.id]);
    const width = Math.max(...fields.map(([name]) => name.length));
    for (const [name, value] of fields) {
      out.line(`       ${paint(name.padEnd(width), styles.muted, out.level)}  ${value}`);
    }
    if (task.description.trim() !== '') {
      out.line();
      for (const line of renderMarkdown(task.description, out.level)) out.line(`       ${line}`);
    }
    if (task.subtasks.length > 0) {
      out.line();
      out.line(`       ${paint(t('show.subtasks'), styles.heading, out.level)}`);
      const rows = task.subtasks.map((sub) => toRow(sub, { tags, dates: ctx, depth: 0 }));
      for (const line of renderRows(rows, out.level, out.columns)) out.line(`     ${line}`);
    }
    if (task.counts.comments > 0) {
      const comments = await recentComments(api, task.id, 5).catch(() => []);
      if (comments.length > 0) {
        const members = await runtime.members(task.orgId).catch(() => []);
        out.line();
        out.line(
          `       ${paint(t('show.comments', { count: task.counts.comments }), styles.heading, out.level)}`,
        );
        for (const comment of comments) {
          const author = members.find((m) => m.userId === comment.authorId)?.name ?? '?';
          const when = new Date(comment.createdAt).toISOString().slice(0, 16).replace('T', ' ');
          out.line(`       ${paint(`${clean(author)} · ${when}`, styles.muted, out.level)}`);
          for (const line of renderMarkdown(
            comment.body.replace(/@\[([^\]]+)\]\(user:[^)]+\)/g, '@$1'),
            out.level,
          )) {
            out.line(`         ${line}`);
          }
        }
      }
    }
  },
});

export const editCommand = defineCommand({
  meta: () => ({ name: 'edit', description: t('cmd.edit') }),
  args: () => ({
    ref: { type: 'positional', required: true, description: t('arg.ref') },
    title: { type: 'string', valueHint: 'text', description: t('edit.arg.title') },
    due: { type: 'string', valueHint: 'phrase|none', description: t('edit.arg.due') },
    time: { type: 'string', valueHint: 'HH:MM|none', description: t('add.arg.time') },
    start: { type: 'string', valueHint: 'date|none', description: t('add.arg.start') },
    desc: { type: 'string', valueHint: 'text', description: t('add.arg.desc') },
    'desc-file': { type: 'string', valueHint: 'path|-', description: t('add.arg.descFile') },
    editor: { type: 'boolean', description: t('edit.arg.editor') },
    assign: { type: 'string', valueHint: 'email|name|me|none', description: t('add.arg.assign') },
    parent: { type: 'string', valueHint: 'ref|none', description: t('edit.arg.parent') },
  }),
  async run({ args }) {
    const runtime = needs('tasks:write');
    const found = await resolveRef(runtime, positionals(args)[0] ?? '');
    const api = await runtime.api();
    const task = await unwrap(
      api.GET('/api/v1/tasks/{id}', { params: { path: { id: found.id } } }),
    );
    const me = await runtime.me();
    const patch: Record<string, unknown> = {};
    const title = str(args.title);
    if (title !== undefined) patch.title = title;
    const flags: DueFlags = { due: str(args.due), time: str(args.time), start: str(args.start) };
    const due = applyDueFlags(task, flags, me, runtime.io.now());
    if (due !== null) Object.assign(patch, due);
    const description =
      args.editor === true
        ? await editText(runtime.io, task.description)
        : await readDescription(runtime, args.desc, args['desc-file']);
    if (description !== undefined) patch.description = description;
    const assign = str(args.assign);
    if (assign !== undefined) {
      patch.assigneeId = await resolveAssignee(runtime, task.orgId, assign);
      if (patch.assigneeId !== me.id) needs('tasks:assign');
    }
    const parent = str(args.parent);
    if (parent !== undefined) {
      patch.parentId = isNone(parent) ? null : (await resolveRef(runtime, parent)).id;
    }
    if (Object.keys(patch).length === 0) {
      if (args.editor === true) {
        runtime.out.notice(t('edit.unchanged'));
        return;
      }
      throw new CliError(EXIT.usage, t('edit.nothing'));
    }
    const result = await unwrap(
      api.PATCH('/api/v1/tasks/{id}', { params: { path: { id: task.id } }, body: patch }),
    );
    rememberLast(runtime, result.task);
    if (result.ignoredFields.length > 0) {
      runtime.out.warn(t('edit.ignored', { fields: result.ignoredFields.join(', ') }));
    }
    await printTasks(runtime, [result.task], { json: result });
  },
});

function completeCommand(completed: boolean) {
  const name = completed ? 'done' : 'undone';
  return defineCommand({
    meta: () => ({ name, description: t(`cmd.${name}`) }),
    args: () => ({ refs: { type: 'positional', required: true, description: t('arg.refs') } }),
    async run({ args }) {
      const runtime = needs('tasks:write');
      const tasks = await resolveRefs(runtime, positionals(args));
      const api = await runtime.api();
      const results = [];
      for (const task of tasks) {
        results.push(
          await unwrap(
            api.POST('/api/v1/tasks/{id}/complete', {
              params: { path: { id: task.id } },
              body: { completed },
            }),
          ),
        );
      }
      if (runtime.out.json) {
        runtime.out.data(results.length === 1 ? results[0] : results);
        return;
      }
      for (const result of results) {
        await printTasks(runtime, [result.task]);
        if (result.next !== undefined) {
          runtime.out.notice(t('done.next'));
          await printTasks(runtime, [result.next]);
        }
      }
    },
  });
}

export const doneCommand = completeCommand(true);
export const undoneCommand = completeCommand(false);

export const mvCommand = defineCommand({
  meta: () => ({ name: 'mv', description: t('cmd.mv') }),
  args: () => ({
    refs: { type: 'positional', required: true, description: t('arg.refs') },
    group: { type: 'string', valueHint: 'name', description: t('mv.arg.group') },
    top: { type: 'boolean', description: t('mv.arg.top') },
    bottom: { type: 'boolean', description: t('mv.arg.bottom') },
    after: { type: 'string', valueHint: 'ref', description: t('mv.arg.after') },
    before: { type: 'string', valueHint: 'ref', description: t('mv.arg.before') },
  }),
  async run({ args }) {
    const runtime = needs('tasks:write');
    const tasks = await resolveRefs(runtime, positionals(args));
    const afterRef = str(args.after);
    const beforeRef = str(args.before);
    const anchor =
      afterRef !== undefined
        ? await resolveRef(runtime, afterRef)
        : beforeRef !== undefined
          ? await resolveRef(runtime, beforeRef)
          : undefined;
    const first = tasks[0] as Task;
    const groupName = str(args.group);
    const orgId = anchor?.orgId ?? first.orgId;
    const groupId =
      groupName !== undefined
        ? (await findGroup(runtime, orgId, groupName)).id
        : (anchor?.placement?.groupId ?? null);
    if (groupId === null) throw new CliError(EXIT.usage, t('mv.groupMissing'));
    const api = await runtime.api();
    let previous: string | null = null;
    if (afterRef !== undefined && anchor !== undefined) previous = anchor.id;
    let top: string | null = null;
    if (afterRef === undefined && beforeRef === undefined && args.bottom !== true) {
      top = (await firstInGroup(api, orgId, groupId))?.id ?? null;
    }
    const moved: Task[] = [];
    for (const task of tasks) {
      let intent: { afterId?: string | null; beforeId?: string | null };
      if (previous !== null) intent = { afterId: previous };
      else if (beforeRef !== undefined && anchor !== undefined) intent = { beforeId: anchor.id };
      else if (args.bottom === true) intent = { afterId: null, beforeId: null };
      else if (top !== null && top === task.id) {
        // Already first: a move without an intent would send it to the end of the group.
        moved.push(task);
        previous = task.id;
        continue;
      } else if (top !== null) intent = { afterId: null, beforeId: top };
      // An empty group: the task becomes its only entry.
      else intent = {};
      const result = await unwrap(
        api.POST('/api/v1/tasks/{id}/move', {
          params: { path: { id: task.id } },
          body: { groupId, ...intent },
        }),
      );
      moved.push({ ...task, placement: result.placement });
      // The rest follow directly below, in the order given.
      if (args.bottom !== true) previous = task.id;
    }
    await printTasks(runtime, moved);
  },
});

export const rmCommand = defineCommand({
  meta: () => ({ name: 'rm', description: t('cmd.rm') }),
  args: () => ({ refs: { type: 'positional', required: true, description: t('arg.refs') } }),
  async run({ args }) {
    const runtime = needs('tasks:delete');
    const tasks = await resolveRefs(runtime, positionals(args));
    if (tasks.length > 3) await confirmOrAbort(runtime, t('rm.confirm', { count: tasks.length }));
    const api = await runtime.api();
    for (const task of tasks) {
      await unwrap(api.DELETE('/api/v1/tasks/{id}', { params: { path: { id: task.id } } }));
    }
    if (runtime.out.json) {
      runtime.out.data(tasks.map((task) => ({ id: task.id, seq: task.seq, deleted: true })));
      return;
    }
    runtime.out.notice(t('rm.done', { count: tasks.length }));
    await printTasks(runtime, tasks);
  },
});

export const restoreCommand = defineCommand({
  meta: () => ({ name: 'restore', description: t('cmd.restore') }),
  args: () => ({ refs: { type: 'positional', required: true, description: t('arg.refs') } }),
  async run({ args }) {
    const runtime = needs('tasks:write');
    const tasks = await resolveRefs(runtime, positionals(args), { deleted: true });
    const api = await runtime.api();
    const restored: Task[] = [];
    for (const task of tasks) {
      await unwrap(api.POST('/api/v1/tasks/{id}/restore', { params: { path: { id: task.id } } }));
      restored.push(
        await unwrap(api.GET('/api/v1/tasks/{id}', { params: { path: { id: task.id } } })),
      );
    }
    await printTasks(runtime, restored);
  },
});

export const commentCommand = defineCommand({
  meta: () => ({ name: 'comment', description: t('cmd.comment') }),
  args: () => ({
    ref: { type: 'positional', required: true, description: t('arg.ref') },
    text: { type: 'positional', required: true, description: t('comment.arg.text') },
  }),
  async run({ args }) {
    const runtime = needs('comments:write');
    const [ref, ...words] = positionals(args);
    const body = words.join(' ').trim();
    if (body === '') throw new CliError(EXIT.usage, t('comment.empty'));
    const task = await resolveRef(runtime, ref ?? '');
    const api = await runtime.api();
    const comment = await unwrap(
      api.POST('/api/v1/tasks/{id}/comments', {
        params: { path: { id: task.id } },
        body: { body },
      }),
    );
    if (runtime.out.json) runtime.out.data(comment);
    else if (runtime.out.quiet) runtime.out.line(comment.id);
    else runtime.out.notice(t('comment.done', { ref: String(task.seq ?? task.id) }));
  },
});

export const searchCommand = defineCommand({
  meta: () => ({ name: 'search', description: t('cmd.search') }),
  args: () => ({
    query: { type: 'positional', required: true, description: t('search.arg.query') },
    'all-orgs': { type: 'boolean', description: t('ls.arg.allOrgs') },
  }),
  async run({ args }) {
    const runtime = needs('tasks:read');
    const q = positionals(args).join(' ').trim();
    if (q === '') throw new CliError(EXIT.usage, t('search.empty'));
    const allOrgs = args['all-orgs'] === true;
    const api = await runtime.api();
    const org = allOrgs ? undefined : await runtime.org();
    const hits = await unwrap(
      api.GET('/api/v1/search', {
        params: { query: { q, limit: 50, ...(org === undefined ? {} : { orgId: org.id }) } },
      }),
    );
    if (runtime.out.json) {
      runtime.out.data(hits);
      return;
    }
    if (hits.length === 0) {
      runtime.out.notice(t('search.none'));
      return;
    }
    await printTasks(
      runtime,
      hits.map((hit) => hit.task),
    );
  },
});

export const openCommand = defineCommand({
  meta: () => ({ name: 'open', description: t('cmd.open') }),
  args: () => ({ ref: { type: 'positional', required: false, description: t('arg.ref') } }),
  async run({ args }) {
    const runtime = rt();
    const server = runtime.server();
    const ref = positionals(args)[0];
    let url: string;
    if (ref === undefined) {
      const org = await runtime.org();
      url = `${server}/o/${encodeURIComponent(org.slug)}/my`;
    } else {
      needs('tasks:read');
      const task = await resolveRef(runtime, ref);
      const org = (await runtime.orgById(task.orgId)) ?? (await runtime.org());
      url = `${server}/o/${encodeURIComponent(org.slug)}/t/${encodeURIComponent(task.id)}`;
    }
    await openInBrowser(runtime, url);
  },
});
