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
 * - Before a subcommand name only global flags may appear (`token --org=acme create` would
 *   lose the option in citty); `--org` before `login` or `token create`, which own it, too.
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

/** How a refused command line asked for output, so the refusal is printed that way too. */
export interface OutputFlags {
  json: boolean;
  quiet: boolean;
  noColor: boolean;
}

/**
 * A refused command line. `output` holds the output switches found at option positions (never
 * in a value position), so `rooster --json edit 41 --title` still reports in JSON (ADR 0039).
 */
export class ArgvError extends CliError {
  constructor(
    message: string,
    readonly output: OutputFlags,
  ) {
    super(EXIT.usage, message);
    this.name = 'ArgvError';
  }
}

const OUTPUT: Readonly<Record<string, keyof OutputFlags>> = {
  '--json': 'json',
  '--quiet': 'quiet',
  '-q': 'quiet',
  '--no-color': 'noColor',
  '--no-colour': 'noColor',
};

/**
 * `extra` adds hand-dispatched subcommands by path (`tag` dispatches its own). Positional
 * words that `free` names (the `tag <ref> +a -b` form) may start with `-`.
 *
 * The walk goes on after the first problem (without consuming a refused value), only to find
 * the output switches; the first problem is what is reported.
 */
export async function checkArgv(
  argv: readonly string[],
  root: CommandDef<ArgsDef>,
  extra: Readonly<Record<string, Commands>> = {},
  free: ReadonlySet<string> = new Set(['tag']),
): Promise<void> {
  const output: OutputFlags = { json: false, quiet: false, noColor: false };
  let problem: string | null = null;
  const refuse = (key: string, values: Record<string, string>) => {
    problem ??= `${t(key, values)}\n${t('usage.seeHelp')}`;
  };
  let cmd = root;
  let path = '';
  let positionals = 0;
  let args = ((await resolve(cmd.args)) ?? {}) as Record<string, ArgDef>;
  /** Options given on the current command so far (citty drops them if a subcommand follows). */
  let here: { flag: string; name: string }[] = [];
  /** `--org` given before the last subcommand name. */
  let orgBefore = false;
  const lookup = (name: string): [string, ArgDef] | undefined => {
    for (const [key, def] of Object.entries(args)) {
      if (def.type === 'positional') continue;
      if (key === name || aliasesOf(def).includes(name)) return [key, def];
    }
    return undefined;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') break;
    /** Consumes the value after `index - 1` when it is one; a refused one stays a word. */
    const value = (flag: string) => {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        refuse('usage.missingValue', { flag });
      } else i += 1;
    };
    const outputFlag = OUTPUT[arg];
    if (outputFlag !== undefined) output[outputFlag] = true;

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = arg.slice(2, eq > 0 ? eq : undefined);
      const flag = `--${name}`;
      here.push({ flag, name });
      const own = lookup(name);
      if (own !== undefined) {
        if (takesValue(own[1])) {
          if (eq < 0) value(flag);
        } else if (eq > 0) refuse('usage.noValue', { flag });
        continue;
      }
      const negated = name.startsWith('no-') ? lookup(name.slice(3)) : undefined;
      if (negated !== undefined) {
        const [key, def] = negated;
        const ok = def.type === 'boolean' || NEGATABLE[path]?.includes(key) === true;
        if (!ok) refuse('usage.unknownOption', { flag });
        else if (eq > 0) refuse('usage.noValue', { flag });
        continue;
      }
      if (GLOBAL_VALUES.has(name)) {
        if (eq < 0) value(flag);
        continue;
      }
      if (GLOBAL_SWITCHES.has(name)) {
        if (eq > 0) refuse('usage.noValue', { flag });
        continue;
      }
      refuse('usage.unknownOption', { flag });
      continue;
    }

    if (arg.startsWith('-') && arg !== '-') {
      if (GLOBAL_SHORT.has(arg)) continue;
      const short = lookup(arg.slice(1));
      if (arg.length === 2 && short !== undefined) {
        here.push({ flag: arg, name: short[0] });
        if (takesValue(short[1])) value(arg);
        continue;
      }
      // `rooster tag 42 -urgent +home`: removals are words of the tag form, not flags.
      if (free.has(path) && positionals > 0) {
        positionals += 1;
        continue;
      }
      refuse('usage.unknownOption', { flag: arg });
      continue;
    }

    if (positionals === 0) {
      const subs = { ...((await resolve(cmd.subCommands)) ?? {}), ...(extra[path] ?? {}) };
      const next = (subs as Commands)[arg];
      if (next !== undefined) {
        // Only global flags may come before a subcommand name: citty hands the subcommand
        // just the words after its name, so anything else there would be dropped silently.
        // `--org` is checked once the command is known, since it may be that command's own.
        for (const option of here) {
          if (option.name === 'org') orgBefore = true;
          else if (option.name === 'profile' || GLOBAL_SWITCHES.has(option.name)) continue;
          else refuse('usage.misplaced', { flag: option.flag, command: arg });
        }
        here = [];
        cmd = (await resolve(next)) as CommandDef<ArgsDef>;
        path = path === '' ? arg : `${path} ${arg}`;
        args = ((await resolve(cmd.args)) ?? {}) as Record<string, ArgDef>;
        continue;
      }
    }
    positionals += 1;
  }
  // `login` and `token create` take `--org` as their own (a grant constraint), so global
  // extraction leaves it in place; before their name, citty would drop it.
  if (orgBefore && lookup('org') !== undefined) {
    refuse('usage.misplaced', { flag: '--org', command: path });
  }
  if (problem !== null) throw new ArgvError(problem, output);
}
