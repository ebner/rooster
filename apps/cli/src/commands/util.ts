import { confirm, isCancel } from '@clack/prompts';
import type { GrantScope } from '@rooster/core/grants';
import type { Tag, Task } from '../api.ts';
import { CliError, EXIT } from '../errors.ts';
import { currentLocale, t } from '../i18n.ts';
import { type DateContext, dateContext, renderRows, toRow } from '../output/format.ts';
import { type Runtime, rt } from '../runtime.ts';

/** A command's long options as given (07 §4), read with real option boundaries. */
export interface GivenOptions {
  /** Every value of each string option, in order (`--remind 1h --remind=due`). */
  values: ReadonlyMap<string, readonly string[]>;
  /** Long switches without a value (`--bottom`, `--no-remind`). */
  switches: ReadonlySet<string>;
}

/** The names of a command's string options, from its citty args. */
export function stringOptions(def: Record<string, { type?: string }>): string[] {
  return Object.entries(def).flatMap(([name, arg]) => (arg.type === 'string' ? [name] : []));
}

/**
 * Reads `rawArgs` (global flags already taken out) up to `--`. A string option takes the next
 * word as its value; a value that is missing or starts with `-` (a lone `-`, stdin, aside) is
 * refused rather than guessed (exit 2): such a value is passed as `--title=--no-remind`. So a
 * switch is never read out of an option's value, and no option silently loses its value. The
 * whole command line was already checked the same way, globals included (`argv-check.ts`);
 * this is the commands' own reading of it.
 */
export function readOptions(rawArgs: readonly string[], strings: readonly string[]): GivenOptions {
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  const add = (name: string, value: string) => {
    const list = values.get(name);
    if (list) list.push(value);
    else values.set(name, [value]);
  };
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i] as string;
    if (arg === '--') break;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq > 0 ? eq : undefined);
    if (!strings.includes(name)) {
      if (eq < 0) switches.add(name);
      continue;
    }
    if (eq > 0) {
      add(name, arg.slice(eq + 1));
      continue;
    }
    const value = rawArgs[i + 1];
    if (value === undefined || (value.startsWith('-') && value !== '-')) {
      throw new CliError(EXIT.usage, t('usage.missingValue', { flag: `--${name}` }));
    }
    add(name, value);
    i += 1;
  }
  return { values, switches };
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
