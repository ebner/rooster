import { type ArgsDef, type CommandDef, defineCommand, renderUsage, runCommand } from 'citty';
import { appsCommand, tokenCommand } from './commands/access.ts';
import { loginCommand, logoutCommand, printVersion, whoamiCommand } from './commands/auth.ts';
import { completeCommand, completionCommand } from './commands/completion.ts';
import { groupCommand } from './commands/groups.ts';
import { lsCommand, runList, todayCommand, weekCommand } from './commands/list.ts';
import { configCommand, orgCommand } from './commands/settings.ts';
import { tagCommand, tagSubCommands } from './commands/tags.ts';
import {
  addCommand,
  commentCommand,
  doneCommand,
  editCommand,
  mvCommand,
  openCommand,
  restoreCommand,
  rmCommand,
  searchCommand,
  showCommand,
  subCommand,
  undoneCommand,
} from './commands/tasks.ts';
import { t } from './i18n.ts';
import { stripAnsi } from './output/color.ts';
import { rt } from './runtime.ts';
import { CLI_VERSION } from './version.ts';

export const rootCommand: CommandDef<ArgsDef> = defineCommand({
  meta: () => ({ name: 'rooster', version: CLI_VERSION, description: t('cmd.root') }),
  subCommands: {
    ls: lsCommand,
    today: todayCommand,
    week: weekCommand,
    add: addCommand,
    show: showCommand,
    edit: editCommand,
    done: doneCommand,
    undone: undoneCommand,
    mv: mvCommand,
    rm: rmCommand,
    restore: restoreCommand,
    sub: subCommand,
    group: groupCommand,
    tag: tagCommand,
    comment: commentCommand,
    search: searchCommand,
    open: openCommand,
    org: orgCommand,
    token: tokenCommand,
    apps: appsCommand,
    login: loginCommand,
    logout: logoutCommand,
    whoami: whoamiCommand,
    config: configCommand,
    completion: completionCommand(() => rootCommand),
    __complete: completeCommand,
  },
});

/** Hand-dispatched subcommands (see `tagCommand`), for help and completion. */
const EXTRA_SUBCOMMANDS: Record<string, Record<string, CommandDef<ArgsDef>>> = {
  tag: tagSubCommands as unknown as Record<string, CommandDef<ArgsDef>>,
};

const resolve = async <T>(value: T | Promise<T> | (() => T | Promise<T>) | undefined) =>
  typeof value === 'function' ? await (value as () => T | Promise<T>)() : await value;

/** The command a help request is about: the longest known path of positionals. */
async function commandFor(args: readonly string[]) {
  let cmd = rootCommand;
  let parent: CommandDef<ArgsDef> | undefined;
  let path = '';
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const subs = {
      ...((await resolve(cmd.subCommands)) ?? {}),
      ...(EXTRA_SUBCOMMANDS[path] ?? {}),
    };
    const next = subs[arg];
    if (next === undefined) break;
    parent = cmd;
    cmd = (await resolve(next)) as CommandDef<ArgsDef>;
    path = path === '' ? arg : `${path} ${arg}`;
  }
  return { cmd, parent, path };
}

export async function renderHelp(args: readonly string[]): Promise<string> {
  const { cmd, parent, path } = await commandFor(args);
  let text = await renderUsage(cmd, parent);
  if (path === '') {
    const globals = [
      ['--org <slug>', t('global.org')],
      ['--profile <name>', t('global.profile')],
      ['--json', t('global.json')],
      ['--quiet, -q', t('global.quiet')],
      ['--no-color', t('global.noColor')],
      ['--yes, -y', t('global.yes')],
      ['--verbose', t('global.verbose')],
      ['--version', t('global.version')],
    ];
    const width = Math.max(...globals.map(([flag]) => (flag ?? '').length));
    text += `\n\n${t('global.title')}\n\n${globals.map(([flag, desc]) => `  ${(flag ?? '').padEnd(width)}  ${desc}`).join('\n')}`;
  }
  const extra = EXTRA_SUBCOMMANDS[path];
  if (extra !== undefined) {
    text += `\n\n${t('help.tagForms')}`;
  }
  return `${text}\n`;
}

/** Runs the command line without globals (already extracted). */
export async function dispatch(rest: readonly string[]): Promise<void> {
  const runtime = rt();
  if (rest.includes('--help') || rest.includes('-h') || rest[0] === 'help') {
    const args = rest[0] === 'help' ? rest.slice(1) : rest;
    const help = await renderHelp(args);
    // citty colours its usage itself; honour NO_COLOR, --no-color and pipes like everything else.
    runtime.io.stdout.write(runtime.out.level === 0 ? stripAnsi(help) : help);
    return;
  }
  if (rest[0] === '--version' || rest[0] === '-V') {
    await printVersion(runtime);
    return;
  }
  if (rest.length === 0) {
    // 07 §4: on a terminal `rooster` will open the TUI (Phase 9); until then, and when piped,
    // it is `rooster ls`.
    if (runtime.io.stdout.isTTY === true && !runtime.globals.json && !runtime.globals.quiet) {
      runtime.out.notice(t('tui.later'));
    }
    await runList(runtime, 'my', {
      tags: [],
      completed: false,
      allOrgs: false,
      subtasks: false,
    });
    return;
  }
  await runCommand(rootCommand, { rawArgs: [...rest] });
}
