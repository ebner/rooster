import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Runs the bash completion with `stub` as the `rooster` command. */
function completeWith(stub: string, words: string[], cwd?: string): string[] {
  const script = join(dir, 'with-stub.bash');
  writeFileSync(script, completionScript('bash', entries));
  const program = `
    ${cwd === undefined ? '' : `cd ${JSON.stringify(cwd)}`}
    source ${JSON.stringify(script)}
    ${stub}
    COMP_WORDS=(${words.map((w) => `'${w.replace(/'/g, `'\\''`)}'`).join(' ')})
    COMP_CWORD=${words.length - 1}
    _rooster
    printf '%s\\n' "\${COMPREPLY[@]}"
  `;
  return execFileSync('bash', ['-c', program], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l !== '');
}

describe('[P2] bash after a partial completion', () => {
  const stub = `rooster() { printf '%s\\n' 'alpha,b1' 'alpha,b2' 'Some group' 'beta'; }`;

  it('matches the escaped word bash inserted on the first Tab (al<Tab>b<Tab>)', () => {
    // First Tab: both candidates, quoted; bash inserts their common prefix alpha\,b.
    expect(completeWith(stub, ['rooster', 'ls', '--tag', 'al'])).toEqual([
      'alpha\\,b1',
      'alpha\\,b2',
    ]);
    // Second Tab: the word is now the escaped prefix.
    expect(completeWith(stub, ['rooster', 'ls', '--tag', 'alpha\\,b'])).toEqual([
      'alpha\\,b1',
      'alpha\\,b2',
    ]);
    expect(completeWith(stub, ['rooster', 'ls', '--tag', 'alpha\\,b2'])).toEqual(['alpha\\,b2']);
    expect(completeWith(stub, ['rooster', 'ls', '--tag', 'Some\\ g'])).toEqual(['Some\\ group']);
  });

  it('[P2] inserts in the quote context the user opened', () => {
    expect(completeWith(stub, ['rooster', 'ls', '--tag', "'Some g"])).toEqual(["'Some group'"]);
    expect(completeWith(stub, ['rooster', 'ls', '--tag', '"alpha,b1'])).toEqual(['"alpha,b1"']);
    expect(completeWith(stub, ['rooster', 'ls', '--tag', 'Some'])).toEqual(['Some\\ group']);
  });

  it('[P2] escapes for each quote context', () => {
    const hostile = `rooster() { printf '%s\\n' "it's" 'a"b$c\`d\\e'; }`;
    expect(completeWith(hostile, ['rooster', 'ls', '--tag', "'it"])).toEqual(["'it'\\''s'"]);
    expect(completeWith(hostile, ['rooster', 'ls', '--tag', '"a'])).toEqual([
      '"a\\"b\\$c\\`d\\\\e"',
    ]);
    expect(completeWith(hostile, ['rooster', 'ls', '--tag', 'a'])).toEqual(['a\\"b\\$c\\`d\\\\e']);
  });

  it('never evaluates the typed word', () => {
    const work = mkdtempSync(join(tmpdir(), 'rooster-pwn-'));
    completeWith(stub, ['rooster', 'ls', '--tag', '$(touch pwned)'], work);
    completeWith(stub, ['rooster', 'ls', '--tag', '`touch pwned2`'], work);
    const listing = execFileSync('ls', ['-A', work], { encoding: 'utf8' });
    rmSync(work, { recursive: true, force: true });
    expect(listing).toBe('');
  });
});

describe('[P2] --profile and --org reach rooster __complete', () => {
  // The stub echoes its arguments back as candidates, one per line.
  const echo = `rooster() { printf '%s\\n' "$@"; }`;

  it('bash passes them as separate arguments, unevaluated', () => {
    const work = mkdtempSync(join(tmpdir(), 'rooster-pwn-'));
    const args = completeWith(
      echo,
      [
        'rooster',
        '--profile',
        'my\\ work',
        'mv',
        '42',
        '--org=acme',
        '--org',
        '$(touch pwned)',
        '--group',
        '',
      ],
      work,
    );
    const listing = execFileSync('ls', ['-A', work], { encoding: 'utf8' });
    rmSync(work, { recursive: true, force: true });
    expect(listing).toBe('');
    // printf %q quoting of: __complete groups --profile 'my work' --org=acme --org '$(touch pwned)'
    expect(args).toEqual([
      '__complete',
      'groups',
      '--profile',
      'my\\ work',
      '--org=acme',
      '--org',
      '\\$\\(touch\\ pwned\\)',
    ]);
  });

  it('[P2] reassembles --org = acme (COMP_WORDBREAKS) and decodes quoted values', () => {
    // As bash splits: rooster --profile 'my work' ls --org=acme --profile="x \"y\"" --tag <Tab>
    expect(
      completeWith(echo, [
        'rooster',
        '--profile',
        "'my work'",
        'ls',
        '--org',
        '=',
        'acme',
        '--profile',
        '=',
        '"x \\"y\\""',
        '--tag',
        '',
      ]),
    ).toEqual([
      '__complete',
      'tags',
      '--profile',
      'my\\ work',
      '--org',
      'acme',
      '--profile',
      'x\\ \\"y\\"',
    ]);
  });

  it('[P2] completes the value after --org= and --group=', () => {
    expect(completeWith(echo, ['rooster', 'ls', '--org', '='])).toEqual(['__complete', 'orgs']);
    const names = `rooster() { printf '%s\\n' Prio Later; }`;
    expect(completeWith(names, ['rooster', 'mv', '42', '--group', '=', 'P'])).toEqual(['Prio']);
  });

  it('the value being completed is not forwarded', () => {
    expect(completeWith(echo, ['rooster', 'ls', '--org', ''])).toEqual(['__complete', 'orgs']);
  });

  it('fish and PowerShell forward them too', () => {
    const fish = completionScript('fish', entries);
    expect(fish).toContain('function __rooster_globals');
    expect(fish).toContain("-a '(rooster __complete groups (__rooster_globals) 2>/dev/null)'");
    const ps = completionScript('powershell', entries);
    expect(ps).toContain('& rooster __complete $source.Substring(4) @extra');
    expect(ps).toContain("$tok -ceq '--profile' -or $tok -ceq '--org'");
  });
});

describe('[P1] PowerShell declines quoting it cannot model', () => {
  it('completes a plain word or an open single quote only', () => {
    const ps = completionScript('powershell', entries);
    expect(ps).toContain(
      "if ($prefix -match '^[''‘’‚‛][^''‘’‚‛]*$') { $prefix = $prefix.Substring(1) }",
    );
    expect(ps).toContain("elseif ($prefix -match '[''‘’‚‛\"“”„$`]') { return }");
    expect(ps).toContain('$_.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)');
  });
});

describe('[P2] PowerShell matching', () => {
  it('is case-insensitive, like PowerShell itself', () => {
    const ps = completionScript('powershell', entries);
    expect(ps).toContain('[System.StringComparison]::OrdinalIgnoreCase');
    expect(ps).not.toContain('[System.StringComparison]::Ordinal)');
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
      "complete -c rooster -l group -x -a '(rooster __complete groups (__rooster_globals) 2>/dev/null)'",
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

/**
 * Real readline in an interactive bash (util-linux `script` provides the terminal): types a
 * line, presses Tab after each part, then dumps the edited line through a key binding.
 */
const hasScript = spawnSync('script', ['-V'], { encoding: 'utf8' }).stdout?.includes('util-linux');

function typeAndComplete(
  parts: string[],
  options: { run?: boolean } = {},
): { line: string; args: string[]; files: string[]; ran: string[] } {
  const work = mkdtempSync(join(tmpdir(), 'rooster-readline-'));
  try {
    writeFileSync(join(work, 'rooster.bash'), completionScript('bash', entries));
    writeFileSync(
      join(work, 'setup.bash'),
      [
        'source rooster.bash',
        // Server names, hostile ones included; a real run records its argv in ran.out.
        `rooster() { if [ "$1" = __complete ]; then printf '%s\\n' "$@" > args.out; printf '%s\\n' 'Some group' "it's" 'a"b$c' 'alpha,b1' 'alpha,b2' 'abc$(touch pwned)' 'xyz$(touch pwned)' 'bang!x'; else printf '%s\\n' "$@" > ran.out; fi; }`,
        `bind -x '"\\C-t": printf "%s" "$READLINE_LINE" > line.out'`,
      ].join('\n'),
    );
    const keys = parts.map((part) => `printf '%s\\t' ${shellQuote(part)}; sleep 0.4;`).join(' ');
    // Ctrl-T dumps the line; Ctrl-U clears it so it is never run (Ctrl-C does not reach readline).
    // With run, Enter executes the completed line instead.
    const end = options.run
      ? `printf '\\n'; sleep 0.4; printf 'exit\\n'`
      : `printf '\\024'; sleep 0.4; printf '\\025exit\\n'`;
    const driver = `(printf 'source setup.bash\\n'; sleep 0.5; ${keys} ${end}) | script -qfc "bash --norc --noprofile -i" /dev/null > /dev/null 2>&1`;
    execFileSync('bash', ['-c', driver], { cwd: work, timeout: 20_000 });
    const read = (name: string) => {
      try {
        return readFileSync(join(work, name), 'utf8');
      } catch {
        return '';
      }
    };
    return {
      line: read('line.out'),
      args: read('args.out')
        .split('\n')
        .filter((l) => l !== ''),
      files: readdirSync(work).sort(),
      ran: read('ran.out')
        .split('\n')
        .filter((l) => l !== ''),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe.skipIf(!hasScript)('bash completion in a real interactive shell (readline)', () => {
  it('inserts in the quote context the user opened', () => {
    expect(typeAndComplete(["rooster ls --group 'Som"]).line).toBe(
      "rooster ls --group 'Some group' ",
    );
    expect(typeAndComplete(['rooster ls --group "Som']).line).toBe(
      'rooster ls --group "Some group" ',
    );
    expect(typeAndComplete(['rooster ls --group Som']).line).toBe(
      'rooster ls --group Some\\ group ',
    );
    expect(typeAndComplete(["rooster ls --group 'it"]).line).toBe("rooster ls --group 'it'\\''s' ");
    expect(typeAndComplete(['rooster ls --group "a\\"']).line).toBe(
      'rooster ls --group "a\\"b\\$c" ',
    );
  });

  it('completes again after a partial completion (al<Tab>1<Tab>)', () => {
    expect(typeAndComplete(['rooster ls --group al']).line).toBe('rooster ls --group alpha\\,b');
    expect(typeAndComplete(['rooster ls --group al', '1']).line).toBe(
      'rooster ls --group alpha\\,b1 ',
    );
    expect(typeAndComplete(["rooster ls --group 'alpha,b", '2']).line).toBe(
      "rooster ls --group 'alpha,b2' ",
    );
  });

  it('forwards --profile and --org, quoted or with =, as separate arguments', () => {
    const { args, line } = typeAndComplete([
      `rooster --profile 'my work' --org=acme ls --group Som`,
    ]);
    expect(line).toBe(`rooster --profile 'my work' --org=acme ls --group Some\\ group `);
    expect(args).toEqual(['__complete', 'groups', '--profile', 'my work', '--org', 'acme']);
  });

  it('[P1] declines words whose quoting it cannot model: nothing inserted, nothing run', () => {
    for (const word of [`'a'"b`, `"a"'b`, `a'b'c`, `$'x`, `$"x`, `"a$b`, '$(touch pwned)']) {
      const line = `rooster ls --group ${word}`;
      const result = typeAndComplete([line]);
      expect(result.line, word).toBe(line);
      expect(result.files, word).not.toContain('pwned');
    }
  });

  it('[P1] a completed hostile name stays one literal argument when the line runs', () => {
    for (const typed of ['"xy', "'xy", 'xy']) {
      const result = typeAndComplete([`rooster ls --group ${typed}`], { run: true });
      expect(result.ran, typed).toEqual(['ls', '--group', 'xyz$(touch pwned)']);
      expect(result.files, typed).not.toContain('pwned');
    }
  });

  it('does not offer a name with ! inside "..." (history expansion)', () => {
    expect(typeAndComplete(['rooster ls --group "ban']).line).toBe('rooster ls --group "ban');
    expect(typeAndComplete(['rooster ls --group ban']).line).toBe('rooster ls --group bang\\!x ');
  });

  it('never runs anything from a name or the typed word', () => {
    const { line, files } = typeAndComplete(['rooster ls --group $(touch pwned)']);
    expect(line).toBe('rooster ls --group $(touch pwned)');
    expect(files).not.toContain('pwned');
  });
});
