import { describe, expect, it } from 'vitest';
import { findMentions, formatMention, mentionedUserIds, mentionsToPlain } from '../src/mentions.ts';

const anna = '01900000-0000-7000-8000-00000000000a';
const bob = '01900000-0000-7000-8000-00000000000b';

describe('mentions', () => {
  it('finds mentions with their offsets', () => {
    const body = `Hi ${formatMention('Anna', anna)}, see ${formatMention('Bob', bob)}`;
    const found = findMentions(body);
    expect(found.map((m) => [m.name, m.userId])).toEqual([
      ['Anna', anna],
      ['Bob', bob],
    ]);
    expect(body.slice(found[0]?.start, found[0]?.end)).toBe(`@[Anna](user:${anna})`);
  });

  it('dedupes mentioned IDs in first-mention order', () => {
    const body = `${formatMention('Bob', bob)} ${formatMention('Anna', anna)} ${formatMention('B', bob)}`;
    expect(mentionedUserIds(body)).toEqual([bob, anna]);
  });

  it('skips malformed IDs and plain @ text', () => {
    expect(findMentions('@[X](user:not-a-uuid-not-a-uuid-not-a-uuid-xx) @anna')).toEqual([]);
    expect(findMentions(`@[X](user:01900000-0000-4000-8000-00000000000a)`)).toEqual([]);
  });

  it('sanitises names when formatting', () => {
    expect(formatMention('A [b]\nc', anna)).toBe(`@[A bc](user:${anna})`);
    expect(formatMention('[]', anna)).toBe(`@[?](user:${anna})`);
  });

  it('renders plain text', () => {
    expect(mentionsToPlain(`Ping ${formatMention('Anna', anna)}!`)).toBe('Ping @Anna!');
    expect(mentionsToPlain('no mentions')).toBe('no mentions');
  });
});
