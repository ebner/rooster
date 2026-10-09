import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError, EXIT } from './errors.ts';
import { t } from './i18n.ts';
import type { Io } from './io.ts';
import { splitCommand } from './launch.ts';

/** The editor argv: `$VISUAL`, `$EDITOR`, else `vi` (`notepad` on Windows). */
export function editorCommand(io: Pick<Io, 'env' | 'platform'>): string[] {
  return splitCommand(
    io.env.VISUAL || io.env.EDITOR || (io.platform === 'win32' ? 'notepad' : 'vi'),
  );
}

/**
 * `edit --editor`: the description in `$EDITOR`. The file has a fixed name in a fresh private
 * directory (0700, removed afterwards), so nothing from the server ever becomes part of a
 * path. Resolves the new text, or undefined when it is unchanged.
 */
export async function editText(
  io: Pick<Io, 'env' | 'platform' | 'runEditor'>,
  text: string,
  tempRoot: string = tmpdir(),
): Promise<string | undefined> {
  const dir = mkdtempSync(join(tempRoot, 'rooster-'));
  try {
    chmodSync(dir, 0o700);
    const file = join(dir, 'description.md');
    writeFileSync(file, text, { mode: 0o600 });
    const code = await io.runEditor(editorCommand(io), file);
    if (code !== 0) throw new CliError(EXIT.unexpected, t('edit.editorFailed', { code }));
    const edited = readFileSync(file, 'utf8');
    return edited === text ? undefined : edited;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
