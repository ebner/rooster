import { describe, expect, it } from 'vitest';
import { CliError } from '../src/errors.ts';
import { parseExpiry, parseGroupSpec, parseScopes, scopeSummary } from '../src/grant-info.ts';

describe('grant flags', () => {
  it('parses comma-separated and repeated scopes', () => {
    expect(parseScopes(['tasks:read,tasks:write', 'groups:write', 'tasks:read'])).toEqual([
      'tasks:read',
      'tasks:write',
      'groups:write',
    ]);
    expect(() => parseScopes(['tasks:admin'])).toThrow(CliError);
  });

  it('parses lifetimes', () => {
    expect(parseExpiry(undefined, 90)).toBe(90);
    expect(parseExpiry('30d', 90)).toBe(30);
    expect(parseExpiry('7', 90)).toBe(7);
    expect(parseExpiry('never', 90)).toBeUndefined();
    expect(() => parseExpiry('0d', 90)).toThrow(CliError);
    expect(() => parseExpiry('soon', 90)).toThrow(CliError);
  });

  it('parses org/Group specs; group names may contain slashes', () => {
    expect(parseGroupSpec('personal/Prio')).toEqual({ org: 'personal', group: 'Prio' });
    expect(parseGroupSpec('acme/Q4/plan')).toEqual({ org: 'acme', group: 'Q4/plan' });
    expect(() => parseGroupSpec('Prio')).toThrow(CliError);
    expect(() => parseGroupSpec('acme/')).toThrow(CliError);
  });

  it('summarises scopes without the implied ones', () => {
    expect(scopeSummary(['tasks:read', 'tasks:write', 'tasks:delete'])).toBe('tasks:delete');
  });
});
