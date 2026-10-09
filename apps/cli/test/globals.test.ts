import { describe, expect, it } from 'vitest';
import { CliError } from '../src/errors.ts';
import { extractGlobals } from '../src/globals.ts';

describe('extractGlobals', () => {
  it('takes global flags from anywhere', () => {
    const { globals, rest } = extractGlobals([
      '--json',
      'ls',
      'today',
      '-q',
      '--org',
      'acme',
      '--no-color',
    ]);
    expect(rest).toEqual(['ls', 'today']);
    expect(globals).toMatchObject({ json: true, quiet: true, noColor: true, org: 'acme' });
  });

  it('accepts --flag=value', () => {
    const { globals, rest } = extractGlobals(['ls', '--profile=work', '--org=x']);
    expect(rest).toEqual(['ls']);
    expect(globals).toMatchObject({ profile: 'work', org: 'x' });
  });

  it('leaves --org to token create and login, where it is a grant constraint', () => {
    expect(extractGlobals(['token', 'create', 'ci', '--org', 'a', '--org', 'b']).rest).toEqual([
      'token',
      'create',
      'ci',
      '--org',
      'a',
      '--org',
      'b',
    ]);
    expect(extractGlobals(['--json', 'login', '--org', 'a']).rest).toEqual(['login', '--org', 'a']);
    expect(extractGlobals(['token', 'ls', '--org', 'a']).globals.org).toBe('a');
  });

  it('stops at --', () => {
    const { globals, rest } = extractGlobals(['add', '--', '--json is a title']);
    expect(globals.json).toBe(false);
    expect(rest).toEqual(['add', '--', '--json is a title']);
  });

  it('needs a value for --org and --profile', () => {
    expect(() => extractGlobals(['ls', '--org'])).toThrow(CliError);
  });
});
