import { describe, expect, it } from 'vitest';
import { CliError } from '../src/errors.ts';
import { expandRefs, parseRef, resolveQuery } from '../src/refs.ts';

describe('parseRef (07 §3)', () => {
  it('reads seqs, org#seq, ID prefixes and @last', () => {
    expect(parseRef('42')).toEqual({ kind: 'seq', seq: 42, org: null });
    expect(parseRef('#42')).toEqual({ kind: 'seq', seq: 42, org: null });
    expect(parseRef('personal#7')).toEqual({ kind: 'seq', seq: 7, org: 'personal' });
    expect(parseRef('acme-co#123')).toEqual({ kind: 'seq', seq: 123, org: 'acme-co' });
    expect(parseRef('0192f3a0')).toEqual({ kind: 'prefix', prefix: '0192f3a0' });
    expect(parseRef('0192F3A0-1B2C')).toEqual({ kind: 'prefix', prefix: '0192f3a0-1b2c' });
    expect(parseRef('01a120a6-bd43-7061-881a-8e8a7414e095')).toMatchObject({ kind: 'prefix' });
    expect(parseRef('@last')).toEqual({ kind: 'last' });
  });

  it('reads eight or more bare digits as an ID prefix, like the server', () => {
    expect(parseRef('1234567')).toEqual({ kind: 'seq', seq: 1234567, org: null });
    expect(parseRef('12345678')).toEqual({ kind: 'prefix', prefix: '12345678' });
  });

  it('rejects anything else as a usage error (exit 2)', () => {
    for (const bad of ['', 'abc', '0192f3a', 'Personal#4', '#', 'x#1', '-1', '4.2', '0192f3a0zz']) {
      expect(() => parseRef(bad), bad).toThrow(CliError);
      try {
        parseRef(bad);
      } catch (error) {
        expect((error as CliError).exitCode).toBe(2);
      }
    }
  });
});

describe('expandRefs', () => {
  it('replaces - with the refs on stdin, skipping blank lines', async () => {
    const stdin = async () => '41\n\n  57 \n# a comment\npersonal#3\n';
    expect(await expandRefs(['1', '-', '9'], stdin)).toEqual(['1', '41', '57', 'personal#3', '9']);
  });

  it('does not read stdin without -', async () => {
    const stdin = async () => {
      throw new Error('read');
    };
    expect(await expandRefs(['1', '2'], stdin)).toEqual(['1', '2']);
  });
});

describe('resolveQuery', () => {
  it('sends a bare seq with the current org, everything else as typed', () => {
    expect(resolveQuery({ kind: 'seq', seq: 4, org: null }, 'acme')).toEqual({
      ref: '4',
      org: 'acme',
    });
    expect(resolveQuery({ kind: 'seq', seq: 4, org: 'personal' }, 'acme')).toEqual({
      ref: 'personal#4',
    });
    expect(resolveQuery({ kind: 'prefix', prefix: '0192f3a0' }, 'acme')).toEqual({
      ref: '0192f3a0',
    });
  });
});
