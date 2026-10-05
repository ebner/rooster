import type { Platform } from './lib/platform';

/**
 * The single keymap registry (AGENTS.md hard rule 8). Phase 1 registers only the
 * global shortcuts the shell uses; WP 2.4 adds the list keys and generates the
 * cheat sheet from this table.
 */
export type ShortcutScope = 'global' | 'navigate';

export interface ShortcutDefinition {
  /** `KeyboardEvent.key` names joined with "+" (the `Kbd` format); `Mod` is ⌘/Ctrl. */
  keys: string;
  scope: ShortcutScope;
}

export const keymap = {
  /** 02 §6: works even while typing. */
  toggleSidebar: { keys: 'Mod+\\', scope: 'global' },
  /** 02 §6: the palette arrives in P5; the sidebar shows the hint already. */
  search: { keys: 'Mod+K', scope: 'global' },
} as const satisfies Record<string, ShortcutDefinition>;

export type ShortcutId = keyof typeof keymap;

interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** True when the event is exactly the shortcut (extra modifiers do not match). */
export function matchesShortcut(event: KeyEventLike, keys: string, platform: Platform): boolean {
  const parts = keys.split('+');
  const key = parts.at(-1) ?? '';
  const wants = new Set(parts.slice(0, -1));
  const mod = platform === 'mac' ? event.metaKey : event.ctrlKey;
  const ctrlExpected = wants.has('Ctrl') || (platform !== 'mac' && wants.has('Mod'));
  const metaExpected = platform === 'mac' && wants.has('Mod');
  if (wants.has('Mod') && !mod) return false;
  if (event.ctrlKey !== ctrlExpected || event.metaKey !== metaExpected) return false;
  if (event.altKey !== wants.has('Alt') || event.shiftKey !== wants.has('Shift')) return false;
  // `code` keeps the shortcut working on layouts where "\" needs AltGr (e.g. Swedish).
  if (key === '\\') return event.key === '\\' || event.code === 'Backslash';
  return event.key.toLowerCase() === key.toLowerCase();
}
