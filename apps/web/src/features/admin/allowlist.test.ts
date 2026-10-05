import { describe, expect, test } from 'vitest';
import { parseAllowlistInput } from './allowlist-section';

describe('parseAllowlistInput', () => {
  test.each([
    ['anna@example.com', { kind: 'email', value: 'anna@example.com' }],
    ['  Anna@Example.COM ', { kind: 'email', value: 'anna@example.com' }],
    ['example.com', { kind: 'domain', value: 'example.com' }],
    ['@northwind.example', { kind: 'domain', value: 'northwind.example' }],
    ['not a domain', null],
    ['localhost', null],
    ['', null],
  ] as const)('%j', (input, expected) => {
    expect(parseAllowlistInput(input)).toEqual(expected);
  });
});
