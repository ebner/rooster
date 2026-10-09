import { join } from 'node:path';
import { type ArgsDef, type CommandDef, defineCommand } from 'citty';
import {
  completionEntries,
  completionScript,
  DYNAMIC_KINDS,
  type DynamicKind,
  SHELLS,
  type Shell,
} from '../completion.ts';
import { readIfExists, writeFileAtomic } from '../config.ts';
import { CliError, EXIT } from '../errors.ts';
import { t } from '../i18n.ts';
import { type Runtime, rt } from '../runtime.ts';
import { positionals } from './util.ts';

/** Dynamic names are cached this long, so completion stays instant (07 §4). */
export const COMPLETION_TTL_MS = 60_000;

async function namesOf(runtime: Runtime, kind: DynamicKind): Promise<string[]> {
  if (kind === 'orgs') return (await runtime.me()).orgs.map((o) => o.slug);
  const org = await runtime.org();
  if (kind === 'tags') return (await runtime.tags(org.id)).map((tag) => tag.name);
  return (await runtime.groups(org.id)).map((group) => group.name);
}

/** Group, tag or org names for the shell, from a 60 s cache per profile and org. */
export async function dynamicNames(runtime: Runtime, kind: DynamicKind): Promise<string[]> {
  const key =
    `${runtime.profileName}-${kind === 'orgs' ? 'all' : runtime.orgRef()}-${kind}`.replace(
      /[^\w.-]/g,
      '_',
    );
  const path = join(runtime.cacheDir, `complete-${key}.json`);
  try {
    const cached = JSON.parse(readIfExists(path) ?? 'null') as {
      at: number;
      names: string[];
    } | null;
    if (cached !== null && runtime.io.now() - cached.at < COMPLETION_TTL_MS) return cached.names;
  } catch {
    // A broken cache is refetched.
  }
  const names = await namesOf(runtime, kind);
  try {
    writeFileAtomic(path, JSON.stringify({ at: runtime.io.now(), names }), 0o600);
  } catch {
    // Completion still works without a cache.
  }
  return names;
}

export function completionCommand(root: () => CommandDef<ArgsDef>) {
  return defineCommand({
    meta: () => ({ name: 'completion', description: t('cmd.completion') }),
    args: () => ({
      shell: { type: 'positional', required: true, description: SHELLS.join(' | ') },
    }),
    async run({ args }) {
      const shell = positionals(args)[0] as Shell | undefined;
      if (shell === undefined || !SHELLS.includes(shell)) {
        throw new CliError(EXIT.usage, t('completion.badShell', { shells: SHELLS.join(', ') }));
      }
      rt().io.stdout.write(completionScript(shell, await completionEntries(root())));
    },
  });
}

/** `rooster __complete groups|tags|orgs`: used by the completion scripts; silent on errors. */
export const completeCommand = defineCommand({
  meta: () => ({ name: '__complete', hidden: true }),
  async run({ args }) {
    const runtime = rt();
    const kind = positionals(args)[0] as DynamicKind | undefined;
    if (kind === undefined || !DYNAMIC_KINDS.includes(kind)) return;
    try {
      for (const name of await dynamicNames(runtime, kind)) {
        // One name per line: a name with a line break or other control character would split
        // or corrupt the list the shell reads, so it is not offered.
        if (hasControlCharacter(name)) continue;
        runtime.io.stdout.write(`${name}\n`);
      }
    } catch {
      // Not logged in or offline: no suggestions rather than an error in the prompt.
    }
  },
});

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
