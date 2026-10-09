import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rootCommand } from '../src/cli.ts';
import { type CompletionEntry, completionEntries, completionScript } from '../src/completion.ts';

let entries: CompletionEntry[];
let dir: string;
beforeAll(async () => {
  entries = await completionEntries(rootCommand);
  dir = mkdtempSync(join(tmpdir(), 'rooster-completion-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const has = (bin: string) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;

describe('completion entries', () => {
  it('cover every visible command, subcommand and flag', () => {
    const root = entries.find((e) => e.path === '');
    expect(root?.subcommands).toEqual(
      expect.arrayContaining(['ls', 'today', 'add', 'group', 'token', 'apps', 'completion']),
    );
    expect(root?.subcommands).not.toContain('__complete');
    expect(entries.find((e) => e.path === 'group')?.subcommands).toEqual([
      'ls',
      'add',
      'rename',
      'mv',
      'rm',
    ]);
    expect(entries.find((e) => e.path === 'add')?.flags).toEqual(
      expect.arrayContaining(['--due', '--tag', '--group', '--no-parse', '--bottom']),
    );
    expect(entries.find((e) => e.path === 'token create')?.flags).toEqual(
      expect.arrayContaining([
        '--scope',
        '--org',
        '--group',
        '--write-group',
        '--expires',
        '--read-only',
      ]),
    );
  });
});

/** Runs the bash completion function for a command line (the cursor at its end). */
function complete(words: string[]): string[] {
  const script = join(dir, 'rooster.bash');
  writeFileSync(script, completionScript('bash', entries));
  const program = `
    source ${JSON.stringify(script)}
    rooster() { [ "$1" = __complete ] && [ "$2" = groups ] && printf 'Prio\\nSome group\\n'; [ "$2" = tags ] && printf 'finance\\n'; true; }
    COMP_WORDS=(${words.map((w) => JSON.stringify(w)).join(' ')})
    COMP_CWORD=${words.length - 1}
    _rooster
    printf '%s\\n' "\${COMPREPLY[@]}"
  `;
  return execFileSync('bash', ['-c', program], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l !== '');
}

describe('bash', () => {
  it('is valid bash', () => {
    const script = join(dir, 'syntax.bash');
    writeFileSync(script, completionScript('bash', entries));
    expect(spawnSync('bash', ['-n', script]).status).toBe(0);
  });

  it('completes commands, subcommands, flags and static values', () => {
    expect(complete(['rooster', 'gr'])).toEqual(['group']);
    expect(complete(['rooster', 'group', 'r'])).toEqual(['rename', 'rm']);
    expect(complete(['rooster', 'add', '--du'])).toEqual(['--due']);
    expect(complete(['rooster', 'ls', 'to'])).toEqual(['today']);
    expect(complete(['rooster', 'completion', 'f'])).toEqual(['fish']);
    expect(complete(['rooster', 'tag', 'add', 'x', '--color', 'bl'])).toEqual(['blue']);
  });

  it('completes group and tag names dynamically (rooster __complete)', () => {
    expect(complete(['rooster', 'mv', '42', '--group', 'P'])).toEqual(['Prio']);
    // Inserted shell-quoted, so the name stays one argument.
    expect(complete(['rooster', 'mv', '42', '--group', 'So'])).toEqual(['Some\\ group']);
    expect(complete(['rooster', 'group', 'rm', ''])).toEqual(['Prio', 'Some\\ group']);
    expect(complete(['rooster', 'ls', '--tag', 'fi'])).toEqual(['finance']);
  });
});

describe('bash with hostile names', () => {
  it('never runs commands hidden in server-provided group or tag names', () => {
    // Any org member can name a tag; compgen -W would run its command substitution.
    const work = mkdtempSync(join(tmpdir(), 'rooster-pwn-'));
    const script = join(dir, 'hostile.bash');
    writeFileSync(script, completionScript('bash', entries));
    const program = `
      cd ${JSON.stringify(work)}
      source ${JSON.stringify(script)}
      rooster() { printf '%s\\n' '$(touch pwned1)' 'x\`touch pwned2\`' "a'b" '*'; }
      COMP_WORDS=(rooster ls --tag "")
      COMP_CWORD=3
      _rooster
      printf '%s\\n' "\${COMPREPLY[@]}"
    `;
    const out = execFileSync('bash', ['-c', program], { encoding: 'utf8' });
    const listing = execFileSync('ls', ['-A', work], { encoding: 'utf8' });
    rmSync(work, { recursive: true, force: true });
    expect(listing).toBe('');
    expect(out.split('\n').filter((l) => l !== '')).toEqual([
      '\\$\\(touch\\ pwned1\\)',
      'x\\`touch\\ pwned2\\`',
      "a\\'b",
      '\\*',
    ]);
  });
});

describe('zsh, fish and PowerShell', () => {
  it('zsh reuses the bash completion through bashcompinit', () => {
    const script = completionScript('zsh', entries);
    expect(script.startsWith('#compdef rooster')).toBe(true);
    expect(script).toContain('bashcompinit');
    if (has('zsh')) {
      writeFileSync(join(dir, 'rooster.zsh'), script);
      expect(spawnSync('zsh', ['-n', join(dir, 'rooster.zsh')]).status).toBe(0);
    }
  });

  it('fish declares commands, flags and dynamic values', () => {
    const script = completionScript('fish', entries);
    expect(script).toContain('complete -c rooster -n "__rooster_at \'\'" -a group');
    expect(script).toContain(
      "complete -c rooster -l group -x -a '(rooster __complete groups 2>/dev/null)'",
    );
    expect(script).toContain('complete -c rooster -n "__rooster_at \'add\'" -l due');
    if (has('fish')) {
      writeFileSync(join(dir, 'rooster.fish'), script);
      expect(spawnSync('fish', ['--no-execute', join(dir, 'rooster.fish')]).status).toBe(0);
    }
  });

  it('PowerShell registers a native argument completer', () => {
    const script = completionScript('powershell', entries);
    expect(script).toContain('Register-ArgumentCompleter -Native -CommandName rooster');
    expect(script).toContain("'group rm' = @(");
    expect(script).toContain("'flag:--group' = 'dyn:groups'");
    // Names are quoted with PowerShell's own escaper, which also doubles typographic quotes
    // (‘ ’ ‚ ‛), so a name like a’$(x) can't end the string early.
    expect(script).toContain('CodeGeneration]::EscapeSingleQuotedStringContent($_)');
    expect(script).not.toContain(`-replace "'", "''"`);
    if (has('pwsh')) {
      writeFileSync(join(dir, 'rooster.ps1'), script);
      const check = spawnSync('pwsh', [
        '-NoProfile',
        '-Command',
        `$null = [System.Management.Automation.Language.Parser]::ParseFile('${join(dir, 'rooster.ps1')}', [ref]$null, [ref]$errors); exit $errors.Count`,
      ]);
      expect(check.status).toBe(0);
    }
  });
});
