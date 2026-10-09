import type { ArgsDef, CommandDef } from 'citty';

/** One completable command path (`ls`, `group rm`): its subcommands and flags. */
export interface CompletionEntry {
  path: string;
  subcommands: string[];
  flags: string[];
}

/** Dynamic value sources, served by `rooster __complete <kind>` (cached 60 s). */
export const DYNAMIC_KINDS = ['groups', 'tags', 'orgs'] as const;
export type DynamicKind = (typeof DYNAMIC_KINDS)[number];

export const SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;
export type Shell = (typeof SHELLS)[number];

export const GLOBAL_FLAGS = [
  '--org',
  '--profile',
  '--json',
  '--quiet',
  '--no-color',
  '--yes',
  '--verbose',
  '--help',
] as const;

const resolve = async <T>(value: T | Promise<T> | (() => T | Promise<T>) | undefined) =>
  typeof value === 'function' ? await (value as () => T | Promise<T>)() : await value;

/** Walks the command tree (hidden commands skipped) into completion entries. */
export async function completionEntries(root: CommandDef<ArgsDef>): Promise<CompletionEntry[]> {
  const out: CompletionEntry[] = [];
  const visit = async (cmd: CommandDef<ArgsDef>, path: string) => {
    const subs = (await resolve(cmd.subCommands)) ?? {};
    const visible: string[] = [];
    for (const [name, sub] of Object.entries(subs)) {
      const def = (await resolve(sub)) as CommandDef<ArgsDef>;
      const meta = await resolve(def.meta);
      if (meta?.hidden) continue;
      visible.push(name);
      await visit(def, path === '' ? name : `${path} ${name}`);
    }
    const args = (await resolve(cmd.args)) ?? {};
    const flags: string[] = [];
    for (const [name, def] of Object.entries(args)) {
      if (def.type === 'positional') continue;
      flags.push(`--${name}`);
      if (def.type === 'boolean' && def.default === true) flags.push(`--no-${name}`);
    }
    out.push({ path, subcommands: visible, flags });
  };
  await visit(root, '');
  return out;
}

/**
 * Where a value comes from: the previous word (a flag) or the position after a command
 * path. Shared by every shell so they complete the same things.
 */
export const VALUE_SOURCES: readonly { when: string; words: string }[] = [
  { when: 'flag:--group', words: 'dyn:groups' },
  { when: 'flag:--move-to', words: 'dyn:groups' },
  { when: 'flag:--write-group', words: 'none' },
  { when: 'flag:--tag', words: 'dyn:tags' },
  { when: 'flag:--org', words: 'dyn:orgs' },
  { when: 'flag:--color', words: 'list:gray red orange amber green teal blue indigo purple pink' },
  {
    when: 'flag:--scope',
    words:
      'list:tasks:read tasks:write comments:write tasks:assign groups:write tasks:delete notifications:read',
  },
  { when: 'cmd:group add:--after', words: 'dyn:groups' },
  { when: 'cmd:group mv:--after', words: 'dyn:groups' },
  { when: 'cmd:group mv:--before', words: 'dyn:groups' },
  { when: 'pos:group rename', words: 'dyn:groups' },
  { when: 'pos:group mv', words: 'dyn:groups' },
  { when: 'pos:group rm', words: 'dyn:groups' },
  { when: 'pos:tag rm', words: 'dyn:tags' },
  { when: 'pos:org use', words: 'dyn:orgs' },
  { when: 'pos:ls', words: 'list:my today week overdue nodate everyone' },
  { when: 'pos:completion', words: 'list:bash zsh fish powershell' },
  { when: 'pos:config get', words: 'list:server org locale default_profile' },
  { when: 'pos:config set', words: 'list:server org locale default_profile' },
];

function shellWords(list: readonly string[]): string {
  return list.join(' ');
}

function bashScript(entries: readonly CompletionEntry[]): string {
  const cases = entries
    .map((e) => {
      const words = [...e.subcommands, ...e.flags, ...GLOBAL_FLAGS];
      return `    "${e.path}") words="${shellWords(words)}" ;;`;
    })
    .join('\n');
  const flagValues = VALUE_SOURCES.filter((s) => s.when.startsWith('flag:'))
    .map((s) => `    ${s.when.slice(5)}) ${valueBash(s.words)}; return ;;`)
    .join('\n');
  const cmdFlagValues = VALUE_SOURCES.filter((s) => s.when.startsWith('cmd:'))
    .map((s) => {
      const [path, flag] = s.when.slice(4).split(':');
      return `    "${path}:${flag}") ${valueBash(s.words)}; return ;;`;
    })
    .join('\n');
  const positional = VALUE_SOURCES.filter((s) => s.when.startsWith('pos:'))
    .map((s) => `    "${s.when.slice(4)}") ${valueBash(s.words)}; return ;;`)
    .join('\n');
  return `# rooster completion for bash (rooster completion bash)
_rooster_values() {
  COMPREPLY=($(compgen -W "$1" -- "$cur"))
}
# The word being completed as the shell will read it: one level of backslash escaping (or an
# opening quote) removed, so a second Tab after inserting 'alpha\\,b' still matches 'alpha,b1'.
# Pure parameter expansion: nothing in the word is ever evaluated.
_rooster_unquote() {
  local s="$1" out="" c
  if [[ "$s" == "'"* ]]; then
    printf '%s' "\${s:1}"
    return
  fi
  [[ "$s" == '"'* ]] && s="\${s:1}"
  while [[ -n "$s" ]]; do
    c="\${s:0:1}"
    s="\${s:1}"
    if [[ "$c" == "\\\\" && -n "$s" ]]; then
      c="\${s:0:1}"
      s="\${s:1}"
    fi
    out+="$c"
  done
  printf '%s' "$out"
}
# Group and tag names come from the server, where any org member can name them: never let the
# shell expand them (compgen -W runs command substitution), and insert them shell-quoted.
# --profile and --org from the command line are passed on as separate arguments.
_rooster_dynamic() {
  local line raw
  raw="$(_rooster_unquote "$cur")"
  COMPREPLY=()
  while IFS= read -r line; do
    [[ "$line" == "$raw"* ]] && COMPREPLY+=("$(printf '%q' "$line")")
  done < <(rooster __complete "$1" "\${globals[@]}" 2>/dev/null)
}
_rooster() {
  local cur prev path="" i w words
  local -a globals=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  for ((i = 1; i < COMP_CWORD; i++)); do
    w="\${COMP_WORDS[i]}"
    case "$w" in
      --org|--profile)
        if ((i + 1 < COMP_CWORD)); then
          globals+=("$w" "$(_rooster_unquote "\${COMP_WORDS[i+1]}")")
        fi
        ((i++)) ;;
      --org=*|--profile=*) globals+=("$(_rooster_unquote "$w")") ;;
      --group|--tag|--move-to|--after|--before|--color|--scope|--write-group|--due|--time|--start|--assign|--desc|--desc-file|--title|--parent|--server|--expires) ((i++)) ;;
      -*) ;;
      *) case " $(_rooster_subs "$path") " in
           *" $w "*) path="\${path:+$path }$w" ;;
         esac ;;
    esac
  done
  case "$path:$prev" in
${cmdFlagValues}
  esac
  case "$prev" in
${flagValues}
  esac
  if [[ "$cur" != -* ]]; then
    case "$path" in
${positional}
    esac
  fi
  case "$path" in
${cases}
    *) words="" ;;
  esac
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
_rooster_subs() {
  case "$1" in
${entries.map((e) => `    "${e.path}") echo "${shellWords(e.subcommands)}" ;;`).join('\n')}
  esac
}
complete -o default -F _rooster rooster
`;
}

function valueBash(words: string): string {
  if (words === 'none') return 'COMPREPLY=()';
  if (words.startsWith('dyn:')) return `_rooster_dynamic ${words.slice(4)}`;
  return `_rooster_values "${words.slice(5)}"`;
}

function zshScript(entries: readonly CompletionEntry[]): string {
  return `#compdef rooster
# rooster completion for zsh (rooster completion zsh): the bash completion through bashcompinit.
autoload -U +X bashcompinit && bashcompinit
${bashScript(entries)}`;
}

function fishScript(entries: readonly CompletionEntry[]): string {
  const lines = [
    '# rooster completion for fish (rooster completion fish | source)',
    'complete -c rooster -f',
    'function __rooster_path',
    '    set -l tokens (commandline -opc)',
    '    set -e tokens[1]',
    '    set -l path',
    '    set -l skip 0',
    '    for tok in $tokens',
    '        if test $skip -eq 1',
    '            set skip 0',
    '            continue',
    '        end',
    '        switch $tok',
    '            case --org --profile --group --tag --move-to --after --before --color --scope --write-group --due --time --start --assign --desc --desc-file --title --parent --server --expires',
    '                set skip 1',
    '            case "-*"',
    '            case "*"',
    '                set path $path $tok',
    '        end',
    '    end',
    '    string join " " $path',
    'end',
    '# --profile and --org from the command line, one argument per line, for rooster __complete.',
    'function __rooster_globals',
    '    set -l tokens (commandline -opc)',
    '    set -l n (count $tokens)',
    '    set -l i 2',
    '    while test $i -le $n',
    '        switch $tokens[$i]',
    '            case --profile --org',
    '                if test $i -lt $n',
    '                    string join \\n -- $tokens[$i] $tokens[(math $i + 1)]',
    '                    set i (math $i + 1)',
    '                end',
    "            case '--profile=*' '--org=*'",
    '                string join \\n -- $tokens[$i]',
    '        end',
    '        set i (math $i + 1)',
    '    end',
    'end',
    'function __rooster_at',
    '    test (__rooster_path) = "$argv[1]"',
    'end',
  ];
  const known = new Set(entries.map((e) => e.path));
  for (const entry of entries) {
    const cond = `"__rooster_at '${entry.path}'"`;
    for (const sub of entry.subcommands) lines.push(`complete -c rooster -n ${cond} -a ${sub}`);
    for (const flag of entry.flags) {
      lines.push(`complete -c rooster -n ${cond} -l ${flag.slice(2)}`);
    }
  }
  for (const flag of GLOBAL_FLAGS) lines.push(`complete -c rooster -l ${flag.slice(2)}`);
  for (const source of VALUE_SOURCES) {
    const words = source.words.startsWith('dyn:')
      ? `'(rooster __complete ${source.words.slice(4)} (__rooster_globals) 2>/dev/null)'`
      : source.words === 'none'
        ? null
        : `'${source.words.slice(5)}'`;
    if (words === null) continue;
    if (source.when.startsWith('flag:')) {
      lines.push(`complete -c rooster -l ${source.when.slice(7)} -x -a ${words}`);
    } else if (source.when.startsWith('cmd:')) {
      const [path, flag] = source.when.slice(4).split(':');
      lines.push(
        `complete -c rooster -n "__rooster_at '${path}'" -l ${flag?.slice(2)} -x -a ${words}`,
      );
    } else if (known.has(source.when.slice(4))) {
      lines.push(`complete -c rooster -n "__rooster_at '${source.when.slice(4)}'" -a ${words}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function powershellScript(entries: readonly CompletionEntry[]): string {
  const table = entries
    .map(
      (e) =>
        `    ${psQuote(e.path)} = @(${[...e.subcommands, ...e.flags, ...GLOBAL_FLAGS].map(psQuote).join(', ')})`,
    )
    .join('\n');
  const values = VALUE_SOURCES.filter((s) => s.words !== 'none')
    .map((s) => `    ${psQuote(s.when)} = ${psQuote(s.words)}`)
    .join('\n');
  return `# rooster completion for PowerShell (rooster completion powershell | Out-String | Invoke-Expression)
$roosterCommands = @{
${table}
}
$roosterValues = @{
${values}
}
$roosterValueFlags = @('--org','--profile','--group','--tag','--move-to','--after','--before','--color','--scope','--write-group','--due','--time','--start','--assign','--desc','--desc-file','--title','--parent','--server','--expires')
Register-ArgumentCompleter -Native -CommandName rooster -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  # Unquoted values ('my profile' → my profile); other elements as written.
  $tokens = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object {
    if ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $_.Value } else { $_.ToString() }
  })
  if ($wordToComplete -ne '' -and $tokens.Count -gt 0) { $tokens = $tokens[0..($tokens.Count - 2)] }
  # --profile and --org are passed on to rooster __complete as separate arguments.
  $extra = @()
  for ($i = 0; $i -lt $tokens.Count; $i++) {
    $tok = $tokens[$i]
    if (($tok -ceq '--profile' -or $tok -ceq '--org') -and $i + 1 -lt $tokens.Count) { $extra += @($tok, $tokens[$i + 1]); $i++ }
    elseif ($tok -clike '--profile=*' -or $tok -clike '--org=*') { $extra += $tok }
  }
  $path = ''
  $prev = ''
  $skip = $false
  foreach ($tok in $tokens) {
    $prev = $tok
    if ($skip) { $skip = $false; continue }
    if ($roosterValueFlags -contains $tok) { $skip = $true; continue }
    if ($tok.StartsWith('-')) { continue }
    $candidate = if ($path -eq '') { $tok } else { "$path $tok" }
    if ($roosterCommands.ContainsKey($candidate)) { $path = $candidate }
  }
  $source = $null
  if ($roosterValues.ContainsKey("cmd:$($path):$prev")) { $source = $roosterValues["cmd:$($path):$prev"] }
  elseif ($roosterValues.ContainsKey("flag:$prev")) { $source = $roosterValues["flag:$prev"] }
  elseif (-not $wordToComplete.StartsWith('-') -and $roosterValues.ContainsKey("pos:$path")) { $source = $roosterValues["pos:$path"] }
  if ($source -ne $null) {
    if ($source.StartsWith('dyn:')) { $words = @(& rooster __complete $source.Substring(4) @extra 2>$null) }
    else { $words = $source.Substring(5).Split(' ') }
  } else {
    $words = $roosterCommands[$path]
  }
  # Server-provided names are quoted unless plain, so a $(...) inside a tag name never runs.
  # PowerShell also ends single-quoted strings at typographic quotes; its own escaper doubles all.
  $words | Where-Object { $_.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object {
    $text = if ($_ -match '^[\\w./:@#+-]+$') { $_ } else {
      "'" + [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($_) + "'"
    }
    [System.Management.Automation.CompletionResult]::new($text, $_, 'ParameterValue', $_)
  }
}
`;
}

export function completionScript(shell: Shell, entries: readonly CompletionEntry[]): string {
  switch (shell) {
    case 'bash':
      return bashScript(entries);
    case 'zsh':
      return zshScript(entries);
    case 'fish':
      return fishScript(entries);
    case 'powershell':
      return powershellScript(entries);
  }
}
