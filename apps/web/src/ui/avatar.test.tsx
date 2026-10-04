import { tagColorNames } from '@rooster/tokens';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { Avatar, avatarColor, hashString, initials } from './avatar';

const ids = Array.from(
  { length: 200 },
  (_, i) => `0192f5d0-7a1e-7c3a-9f10-${String(i).padStart(12, '0')}`,
);

describe('avatar fallback', () => {
  test('colour is deterministic per id', () => {
    for (const id of ids) expect(avatarColor(id)).toBe(avatarColor(id));
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });

  test('colours spread over the whole tag palette', () => {
    const used = new Set(ids.map(avatarColor));
    expect(used.size).toBe(tagColorNames.length);
  });

  test.each([
    ['Anna Lindqvist', 2, 'AL'],
    ['Markus Lindén', 2, 'ML'],
    ['Karl Johan Svensson', 2, 'KS'],
    ['sara', 2, 'S'],
    ['  Olof   Bergström ', 1, 'O'],
    ['Örjan Åberg', 2, 'ÖÅ'],
  ] as const)('initials(%j, %i) → %s', (name, max, expected) => {
    expect(initials(name, max)).toBe(expected);
  });

  test('renders initials with the hashed colour and an accessible name', () => {
    render(<Avatar id={ids[7] ?? ''} name="Anna Lindqvist" size={32} />);
    const avatar = screen.getByRole('img', { name: 'Anna Lindqvist' });
    expect(avatar.textContent).toBe('AL');
    const color = avatarColor(ids[7] ?? '');
    expect(avatar.getAttribute('data-color')).toBe(color);
    expect(avatar.className).toContain(`bg-tag-${color}-bg`);
  });

  test('falls back to initials when the image fails', () => {
    render(<Avatar id="u1" name="Jannik Lunde" src="/broken.png" size={24} />);
    const img = screen.getByRole('img', { name: 'Jannik Lunde' });
    expect(img.tagName).toBe('IMG');
    fireEvent.error(img);
    const fallback = screen.getByRole('img', { name: 'Jannik Lunde' });
    expect(fallback.tagName).toBe('SPAN');
    expect(fallback.textContent).toBe('HE');
  });

  test('org avatar is a rounded square and small sizes show one letter', () => {
    render(<Avatar id="org" name="Northwind" shape="square" size={16} />);
    const avatar = screen.getByRole('img', { name: 'Northwind' });
    expect(avatar.className).toContain('rounded-xs');
    expect(avatar.textContent).toBe('M');
  });
});
