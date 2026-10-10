import type { ArgDef, ArgsDef, CommandDef } from 'citty';
import { CliError, EXIT } from './errors.ts';
import { t } from './i18n.ts';

/**
 * Checks the whole command line before anything reads it (07 §4): global-flag extraction,
 * citty and the commands' own `readOptions` would each read a word differently, so every
 * spelling that any of them accepts must pass the same boundary check here first.
 *
 * - Only declared spellings: the kebab-case names of the command's options, `--no-<name>` for
 *   booleans (and the string options in `NEGATABLE`), declared aliases, and the global flags.
 *   citty's camelCase forms (`--descFile`) and anything unknown are refused, since citty would
 *   otherwise apply them past this check.
 * - A value is never another flag: an option that takes one must be followed by a word that
 *   does not start with `-` (a lone `-`, stdin, is a value). Such a value is passed with `=`
 *   (`--title=--no-remind`). So a global flag cannot be lifted out of an option's value
 *   (`--scope --quiet tasks:write`), and no switch is read out of one.
 * - Booleans take no `=value`.
 *
 * Everything after `--` is positional. Refusals are usage errors (exit 2).
 */

/** String options whose `--no-` form means something, per command path (`edit --no-remind`). */
export const NEGATABLE: Readonly<Record<string, readonly string[]>> = { edit: ['remind'] };

const GLOBAL_SWITCHES = new Set([
  'json',
  'quiet',
  'no-color',
  'no-colour',
  'yes',
  'verbose',
  'help',
  'version',
]);
const GLOBAL_SHORT = new Set(['-q', '-y', '-h', '-V']);
const GLOBAL_VALUES = new Set(['profile', 'org']);

type Commands = Record<string, CommandDef<ArgsDef>>;

const resolve = async <T>(value: T | Promise<T> | (() => T | Promise<T>) | undefined) =>
  typeof value === 'function' ? await (value as () => T | Promise<T>)() : await value;

const takesValue = (def: ArgDef) => def.type === 'string' || def.type === 'enum';

function aliasesOf(def: ArgDef): string[] {
  const alias = (def as { alias?: string | string[] }).alias;
  return alias === undefined ? [] : Array.isArray(alias) ? alias : [alias];
}

function refuse(key: string, flag: string): never {
  throw new CliError(EXIT.usage, `${t(key, { flag })}\n${t('usage.seeHelp')}`);
}

/**
 * `extra` adds hand-dispatched subcommands by path (`tag` dispatches its own). Positional
 * words that `free` names (the `tag <ref> +a -b` form) may start with `-`.
 */
export async function checkArgv(
  argv: readonly string[],
  root: CommandDef<ArgsDef>,
  extra: Readonly<Record<string, Commands>> = {},
  free: ReadonlySet<string> = new Set(['tag']),
): Promise<void> {
  let cmd = root;
  let path = '';
  let positionals = 0;
  let args = ((await resolve(cmd.args)) ?? {}) as Record<string, ArgDef>;
  const lookup = (name: string): [string, ArgDef] | undefined => {
    for (const [key, def] of Object.entries(args)) {
      if (def.type === 'positional') continue;
      if (key === name || aliasesOf(def).includes(name)) return [key, def];
    }
    return undefined;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') return;
    const valueAt = (index: number, flag: string) => {
      const value = argv[index];
      if (value === undefined || (value.startsWith('-') && value !== '-')) {
        refuse('usage.missingValue', flag);
      }
    };

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = arg.slice(2, eq > 0 ? eq : undefined);
      const flag = `--${name}`;
      const own = lookup(name);
      if (own !== undefined) {
        if (takesValue(own[1])) {
          if (eq < 0) valueAt(++i, flag);
        } else if (eq > 0) refuse('usage.noValue', flag);
        continue;
      }
      const negated = name.startsWith('no-') ? lookup(name.slice(3)) : undefined;
      if (negated !== undefined) {
        const [key, def] = negated;
        const ok = def.type === 'boolean' || NEGATABLE[path]?.includes(key) === true;
        if (!ok) refuse('usage.unknownOption', flag);
        if (eq > 0) refuse('usage.noValue', flag);
        continue;
      }
      if (GLOBAL_VALUES.has(name)) {
        if (eq < 0) valueAt(++i, flag);
        continue;
      }
      if (GLOBAL_SWITCHES.has(name)) {
        if (eq > 0) refuse('usage.noValue', flag);
        continue;
      }
      refuse('usage.unknownOption', flag);
    }

    if (arg.startsWith('-') && arg !== '-') {
      if (GLOBAL_SHORT.has(arg)) continue;
      const short = lookup(arg.slice(1));
      if (arg.length === 2 && short !== undefined) {
        if (takesValue(short[1])) valueAt(++i, arg);
        continue;
      }
      // `rooster tag 42 -urgent +home`: removals are words of the tag form, not flags.
      if (free.has(path) && positionals > 0) {
        positionals += 1;
        continue;
      }
      refuse('usage.unknownOption', arg);
    }

    if (positionals === 0) {
      const subs = { ...((await resolve(cmd.subCommands)) ?? {}), ...(extra[path] ?? {}) };
      const next = (subs as Commands)[arg];
      if (next !== undefined) {
        cmd = (await resolve(next)) as CommandDef<ArgsDef>;
        path = path === '' ? arg : `${path} ${arg}`;
        args = ((await resolve(cmd.args)) ?? {}) as Record<string, ArgDef>;
        continue;
      }
    }
    positionals += 1;
  }
}
