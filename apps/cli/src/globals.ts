import { CliError, EXIT } from './errors.ts';
import { t } from './i18n.ts';
import { type Globals, NO_GLOBALS } from './runtime.ts';

const BOOLEAN_FLAGS: Readonly<Record<string, keyof Globals>> = {
  '--json': 'json',
  '--quiet': 'quiet',
  '-q': 'quiet',
  '--no-color': 'noColor',
  '--no-colour': 'noColor',
  '--yes': 'yes',
  '-y': 'yes',
  '--verbose': 'verbose',
};
const VALUE_FLAGS: Readonly<Record<string, 'profile' | 'org'>> = {
  '--profile': 'profile',
  '--org': 'org',
};

/**
 * `--org` is a grant constraint (repeatable) for these commands, not the org to work in
 * (07 §4, 11 §2.2), so it stays with the command.
 */
function ownsOrgFlag(command: string | undefined, sub: string | undefined): boolean {
  return command === 'login' || (command === 'token' && sub === 'create');
}

/**
 * Takes the global flags (07 §4) out of argv wherever they appear, so `rooster --json ls`
 * and `rooster ls --json` mean the same; everything else goes to the command parser.
 */
export function extractGlobals(argv: readonly string[]): { globals: Globals; rest: string[] } {
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') break;
    if (arg.startsWith('-')) {
      if (arg in VALUE_FLAGS) i++;
      continue;
    }
    positionals.push(arg);
    if (positionals.length === 2) break;
  }
  const keepOrg = ownsOrgFlag(positionals[0], positionals[1]);

  const globals: Globals = { ...NO_GLOBALS };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    const bool = BOOLEAN_FLAGS[arg];
    if (bool !== undefined) {
      (globals as unknown as Record<string, boolean>)[bool] = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const key = VALUE_FLAGS[name];
    if (key !== undefined && !(key === 'org' && keepOrg)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '') {
        throw new CliError(EXIT.usage, t('usage.missingValue', { flag: name }));
      }
      globals[key] = value;
      continue;
    }
    rest.push(arg);
  }
  return { globals, rest };
}
