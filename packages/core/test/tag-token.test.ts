import { describe, expect, it } from 'vitest';
import { findTagTokens, removeSpans } from '../src/dates/index.ts';

describe('#tag tokens (02 §3.4, ADR 0007)', () => {
  it('finds tokens anywhere in the title, in order', () => {
    const tokens = findTagTokens('Pay #finance invoice tom #home-office');
    expect(tokens.map((t) => t.name)).toEqual(['finance', 'home-office']);
    expect(tokens[0]).toMatchObject({ start: 4, end: 12 });
  });

  it('needs whitespace before and a word end after', () => {
    expect(findTagTokens('issue#12 and #ok, #fine.')).toMatchObject([
      { name: 'ok' },
      { name: 'fine' },
    ]);
    expect(findTagTokens('#a/b')).toEqual([]);
    expect(findTagTokens(`#${'x'.repeat(41)}`)).toEqual([]);
  });

  it('skips tokens inside backtick escapes', () => {
    expect(findTagTokens('Write `#notatag` docs #tag').map((t) => t.name)).toEqual(['tag']);
  });

  it('removes spans, keeping one space each', () => {
    const title = 'Pay #finance invoice #x';
    expect(removeSpans(title, findTagTokens(title))).toBe('Pay   invoice  ');
    expect(
      removeSpans('abcdef', [
        { start: 2, end: 4 },
        { start: 3, end: 5 },
      ]),
    ).toBe('ab ef');
  });
});
