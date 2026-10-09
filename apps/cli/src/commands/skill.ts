import { join } from 'node:path';
import { skillMarkdown } from '@rooster/mcp';
import { defineCommand } from 'citty';
import { normalizeServer } from '../config.ts';
import { CliError, EXIT } from '../errors.ts';
import { t } from '../i18n.ts';
import { type Runtime, rt } from '../runtime.ts';
import {
  assertNoSymlinksBelow,
  readRegularFile,
  UnsafePathError,
  writeFileAtomic,
} from '../safe-write.ts';
import { CLI_VERSION } from '../version.ts';

/** Where agents look for skills (11 §6.2): Claude's own folder, or the shared `.agents`. */
export const SKILL_TARGETS = ['claude', 'agents'] as const;
export type SkillTarget = (typeof SKILL_TARGETS)[number];

/** The skill for the profile's server (`--server` overrides it; no login needed). */
function skillFor(runtime: Runtime, serverFlag: unknown): string {
  const server =
    typeof serverFlag === 'string' && serverFlag !== ''
      ? normalizeServer(serverFlag)
      : runtime.serverOrNull();
  if (server === null) throw new CliError(EXIT.usage, t('skill.serverMissing'));
  return skillMarkdown({ instanceUrl: server, version: CLI_VERSION });
}

export interface SkillInstall {
  target: SkillTarget;
  project: boolean;
  homedir: string;
  cwd: string;
}

/** `~/.claude/skills/rooster/SKILL.md`, `~/.agents/skills/rooster/SKILL.md`, or the same under the cwd. */
export function skillPath(options: SkillInstall): { base: string; file: string } {
  const base = options.project ? options.cwd : options.homedir;
  const folder = options.target === 'claude' ? '.claude' : '.agents';
  return { base, file: join(base, folder, 'skills', 'rooster', 'SKILL.md') };
}

export type SkillInstallStatus = 'added' | 'updated' | 'unchanged';

/**
 * Writes the skill: atomically, keeping a backup of a different earlier file, never through
 * a symlink. Under `--project` the tree may be a cloned repository, so no component below the
 * directory may be a link (a planted `.claude -> ~` must not redirect the write); in the home
 * directory only the skill's own folder and file are checked, so a dotfiles-linked `~/.claude`
 * keeps working.
 */
export function installSkill(
  options: SkillInstall,
  content: string,
  now: number,
): { file: string; status: SkillInstallStatus; backup: string | null } {
  const { base, file } = skillPath(options);
  if (options.project) assertNoSymlinksBelow(base, file);
  else assertNoSymlinksBelow(join(file, '..', '..'), file);
  const previous = readRegularFile(file);
  if (previous !== null && previous.text === content) {
    return { file, status: 'unchanged', backup: null };
  }
  const { backup } = writeFileAtomic(file, content, {
    previous,
    newMode: 0o644,
    backup: true,
    now,
  });
  return { file, status: previous === null ? 'added' : 'updated', backup };
}

const printCommand = defineCommand({
  meta: () => ({ name: 'print', description: t('skill.cmd.print') }),
  args: () => ({
    server: { type: 'string', valueHint: 'url', description: t('skill.arg.server') },
  }),
  async run({ args }) {
    const runtime = rt();
    runtime.io.stdout.write(skillFor(runtime, args.server));
  },
});

const installCommand = defineCommand({
  meta: () => ({ name: 'install', description: t('skill.cmd.install') }),
  args: () => ({
    target: {
      type: 'string',
      valueHint: SKILL_TARGETS.join('|'),
      description: t('skill.arg.target'),
    },
    project: { type: 'boolean', description: t('skill.arg.project') },
    server: { type: 'string', valueHint: 'url', description: t('skill.arg.server') },
  }),
  async run({ args }) {
    const runtime = rt();
    const target = (
      typeof args.target === 'string' && args.target !== '' ? args.target : 'claude'
    ) as SkillTarget;
    if (!SKILL_TARGETS.includes(target)) {
      throw new CliError(
        EXIT.usage,
        t('skill.badTarget', { target, targets: SKILL_TARGETS.join(', ') }),
      );
    }
    const content = skillFor(runtime, args.server);
    let result: ReturnType<typeof installSkill>;
    try {
      result = installSkill(
        { target, project: args.project === true, homedir: runtime.io.homedir, cwd: process.cwd() },
        content,
        runtime.io.now(),
      );
    } catch (error) {
      if (error instanceof UnsafePathError) {
        throw new CliError(
          EXIT.conflict,
          t(`mcp.setup.unsafe.${error.reason}`, { path: error.path }),
        );
      }
      throw error;
    }
    const { out } = runtime;
    if (out.json) {
      out.data(result);
      return;
    }
    if (out.quiet) {
      out.line(result.file);
      return;
    }
    out.notice(t(`skill.${result.status}`, { path: result.file }));
    if (result.backup !== null) out.notice(t('mcp.setup.backup', { path: result.backup }));
  },
});

/** `rooster skill print|install` (11 §6.2, WP 9.5). */
export const skillCommand = defineCommand({
  meta: () => ({ name: 'skill', description: t('cmd.skill') }),
  subCommands: { print: printCommand, install: installCommand },
});
