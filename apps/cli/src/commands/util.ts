import { confirm, isCancel } from '@clack/prompts';
import type { GrantScope } from '@rooster/core/grants';
import type { Tag, Task } from '../api.ts';
import { CliError, EXIT } from '../errors.ts';
import { currentLocale, t } from '../i18n.ts';
import { type DateContext, dateContext, renderRows, toRow } from '../output/format.ts';
import { type Runtime, rt } from '../runtime.ts';

/** Every value of a repeatable flag (`--tag a --tag b`, `--tag=c`), in order. */
export function multi(rawArgs: readonly string[], ...names: string[]): string[] {
  const flags = new Set(names.map((n) => `--${n}`));
  const out: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i] as string;
    if (arg === '--') break;
    const eq = arg.indexOf('=');
    if (eq > 0 && flags.has(arg.slice(0, eq))) out.push(arg.slice(eq + 1));
    else if (flags.has(arg) && i + 1 < rawArgs.length) out.push(rawArgs[++i] as string);
  }
  return out;
}

/** Whether `--name` was given (before any `--`), e.g. a `--no-x` that citty folds into `x`. */
export function flagGiven(rawArgs: readonly string[], name: string): boolean {
  const end = rawArgs.indexOf('--');
  return (end === -1 ? rawArgs : rawArgs.slice(0, end)).includes(`--${name}`);
}

/** Positional arguments as citty parsed them (everything after `--` included). */
export function positionals(args: { _: string[] }): string[] {
  return args._.map(String);
}

/** Declares the capability the command needs (explains `403 forbidden_scope`). */
export function needs(scope: GrantScope): Runtime {
  const runtime = rt();
  runtime.requiredScope = scope;
  return runtime;
}

/**
 * Asks before something destructive. `--yes` skips it; without a terminal to ask on, the
 * command refuses (exit 2) rather than guessing.
 */
export async function confirmOrAbort(runtime: Runtime, message: string): Promise<void> {
  if (runtime.globals.yes) return;
  if (!runtime.io.stdinIsTTY || runtime.io.stdout.isTTY !== true) {
    throw new CliError(EXIT.usage, t('confirm.needYes'));
  }
  const answer = await confirm({ message });
  if (isCancel(answer) || answer !== true)
    throw new CliError(EXIT.unexpected, t('confirm.aborted'));
}

export async function dates(runtime: Runtime): Promise<DateContext> {
  return dateContext(await runtime.me(), currentLocale(), runtime.io.now());
}

export async function tagMap(runtime: Runtime, orgId: string): Promise<Map<string, Tag>> {
  return new Map((await runtime.tags(orgId)).map((tag) => [tag.id, tag]));
}

/**
 * Prints tasks after a mutation: JSON DTOs, the refs (`--quiet`), or aligned task lines.
 * `json` overrides what is emitted with `--json` (e.g. a `{task, next}` result).
 */
export async function printTasks(
  runtime: Runtime,
  tasks: readonly Task[],
  options: { json?: unknown; prefix?: string } = {},
): Promise<void> {
  const { out } = runtime;
  if (out.json) {
    out.data(options.json ?? (tasks.length === 1 ? tasks[0] : tasks));
    return;
  }
  if (out.quiet) {
    for (const task of tasks) out.line(String(task.seq ?? task.id));
    return;
  }
  const ctx = await dates(runtime);
  const orgIds = [...new Set(tasks.map((task) => task.orgId))];
  const tags = new Map<string, Tag>();
  for (const orgId of orgIds) {
    for (const [id, tag] of await tagMap(runtime, orgId).catch(() => new Map<string, Tag>())) {
      tags.set(id, tag);
    }
  }
  const current = await runtime.org().catch(() => null);
  const rows = await Promise.all(
    tasks.map(async (task) => {
      const org = task.orgId === current?.id ? undefined : await runtime.orgById(task.orgId);
      return toRow(task, {
        tags,
        dates: ctx,
        ...(org === undefined ? {} : { orgSlug: org.slug }),
      });
    }),
  );
  const lines = renderRows(rows, out.level, out.columns);
  for (const line of lines) out.line(options.prefix ? `${options.prefix}${line}` : line);
}
