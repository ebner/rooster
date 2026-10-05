import { describe, expect, test } from 'vitest';
import { keymap, matchesShortcut } from './keymap';

const event = (
  key: string,
  mods: Partial<Record<'ctrl' | 'meta' | 'alt' | 'shift', boolean>> = {},
  code?: string,
) => ({
  key,
  ...(code ? { code } : {}),
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

describe('matchesShortcut', () => {
  test('Mod is Ctrl elsewhere and ⌘ on macOS', () => {
    expect(matchesShortcut(event('\\', { ctrl: true }), keymap.toggleSidebar.keys, 'other')).toBe(
      true,
    );
    expect(matchesShortcut(event('\\', { meta: true }), keymap.toggleSidebar.keys, 'mac')).toBe(
      true,
    );
    expect(matchesShortcut(event('\\', { meta: true }), keymap.toggleSidebar.keys, 'other')).toBe(
      false,
    );
  });
  test('matches the physical backslash key on layouts that need AltGr', () => {
    expect(
      matchesShortcut(event("'", { ctrl: true }, 'Backslash'), keymap.toggleSidebar.keys, 'other'),
    ).toBe(true);
  });
  test('extra modifiers do not match', () => {
    expect(
      matchesShortcut(event('k', { ctrl: true, shift: true }), keymap.search.keys, 'other'),
    ).toBe(false);
    expect(matchesShortcut(event('K', { ctrl: true }), keymap.search.keys, 'other')).toBe(true);
  });
});
