import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editText } from '../src/editor.ts';
import { CliError } from '../src/errors.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rooster-editor-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('edit --editor temp file (no server text in the path)', () => {
  it('uses a fixed name in a fresh 0700 directory, whatever the task looks like, and removes it', async () => {
    const seen: { file: string; dirMode: number; editor: readonly string[] }[] = [];
    const io = {
      env: { EDITOR: 'nano -w' },
      platform: 'linux' as const,
      runEditor: async (editor: readonly string[], file: string) => {
        seen.push({ file, dirMode: statSync(dirname(file)).mode & 0o777, editor });
        writeFileSync(file, 'edited');
        return 0;
      },
    };
    // A hostile server could send any seq or title; neither reaches the path any more.
    expect(await editText(io, 'x/../../outside', root)).toBe('edited');
    const [call] = seen;
    expect(basename(call?.file ?? '')).toBe('description.md');
    expect(dirname(dirname(call?.file ?? ''))).toBe(root);
    expect(call?.dirMode).toBe(0o700);
    expect(call?.editor).toEqual(['nano', '-w']);
    expect(existsSync(dirname(call?.file ?? ''))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(join(root, '..', 'outside'))).toBe(false);
  });

  it('returns undefined when unchanged, and fails (cleaning up) when the editor fails', async () => {
    const unchanged = { env: {}, platform: 'linux' as const, runEditor: async () => 0 };
    expect(await editText(unchanged, 'same', root)).toBeUndefined();
    const failing = { env: {}, platform: 'linux' as const, runEditor: async () => 1 };
    await expect(editText(failing, 'x', root)).rejects.toBeInstanceOf(CliError);
    expect(readdirSync(root)).toEqual([]);
  });
});
