import type { Platform } from './lib/platform';

/**
 * The single keymap registry (AGENTS.md hard rule 8, 04 §5.3, 02 §6). `useKeymap()`
 * dispatches from it, the title input matches its edit keys against it, and the `?`
 * cheat sheet is generated from it; keys are never documented anywhere else.
 *
 * Key syntax (`KeyboardEvent.key` names, the `Kbd` format):
 * - `Mod+K`: modifiers joined with "+"; `Mod` is ⌘ on Apple platforms, Ctrl elsewhere.
 * - `Tab+N`: a Tab chord, fired while Tab is held (02 §6).
 * - `G M`: a G-sequence, the second key within 1 s.
 *
 * Scopes:
 * - `global`: modifier chords that work even while typing.
 * - `navigate`: single keys in Navigate, never while a text input has focus.
 * - `list`: list keys in both modes (modifier chords and Tab chords).
 * - `edit`: handled by the focused title input itself.
 * - `drag`: handled by a focused drag handle.
 * - `picker`: handled inside the date popover (matched by `event.code`, 02 §7).
 */
export type ShortcutScope = 'global' | 'navigate' | 'list' | 'edit' | 'drag' | 'picker';

export type ShortcutSection = 'general' | 'navigation' | 'editing' | 'moving' | 'groups' | 'dates';

export interface ShortcutDefinition {
  /** Alternatives; the first is the one shown in tooltips and menus. */
  keys: readonly string[];
  scope: ShortcutScope;
  section: ShortcutSection;
  /** Cheat-sheet label override, e.g. `Mod+1…9` for a range. */
  display?: string;
}

export const keymap = {
  // Global (modifier chords only, work even while typing).
  search: { keys: ['Mod+K'], scope: 'global', section: 'general' },
  toggleSidebar: { keys: ['Mod+\\'], scope: 'global', section: 'general' },
  goToOrg: {
    keys: ['Mod+1', 'Mod+2', 'Mod+3', 'Mod+4', 'Mod+5', 'Mod+6', 'Mod+7', 'Mod+8', 'Mod+9'],
    scope: 'global',
    section: 'general',
    display: 'Mod+1…9',
  },
  undo: { keys: ['Mod+Z'], scope: 'global', section: 'general' },
  redo: { keys: ['Mod+Shift+Z', 'Ctrl+Y'], scope: 'global', section: 'general' },
  cheatSheet: { keys: ['?'], scope: 'navigate', section: 'general' },
  goMyTasks: { keys: ['G M'], scope: 'navigate', section: 'general' },
  goSettings: { keys: ['G S'], scope: 'navigate', section: 'general' },

  // Navigate (single keys).
  selectPrevious: { keys: ['ArrowUp', 'K'], scope: 'navigate', section: 'navigation' },
  selectNext: { keys: ['ArrowDown', 'J'], scope: 'navigate', section: 'navigation' },
  extendUp: { keys: ['Shift+ArrowUp'], scope: 'navigate', section: 'navigation' },
  extendDown: { keys: ['Shift+ArrowDown'], scope: 'navigate', section: 'navigation' },
  selectFirst: { keys: ['Home'], scope: 'navigate', section: 'navigation' },
  selectLast: { keys: ['End'], scope: 'navigate', section: 'navigation' },
  selectAll: { keys: ['Mod+A'], scope: 'navigate', section: 'navigation' },
  toggleInSelection: { keys: ['X'], scope: 'navigate', section: 'navigation' },
  collapse: { keys: ['ArrowLeft'], scope: 'navigate', section: 'navigation' },
  expand: { keys: ['ArrowRight'], scope: 'navigate', section: 'navigation' },
  toggleCompleted: { keys: ['Shift+H'], scope: 'navigate', section: 'navigation' },
  editTitle: { keys: ['Enter', 'F2', 'I'], scope: 'navigate', section: 'editing' },
  newBelowNavigate: { keys: ['N'], scope: 'navigate', section: 'editing' },
  newAboveNavigate: { keys: ['Shift+N'], scope: 'navigate', section: 'editing' },
  quickAddNavigate: { keys: ['Q'], scope: 'navigate', section: 'editing' },
  dateNavigate: { keys: ['D'], scope: 'navigate', section: 'editing' },
  moveToNavigate: { keys: ['M'], scope: 'navigate', section: 'moving' },
  deleteNavigate: { keys: ['Delete', 'Backspace'], scope: 'navigate', section: 'editing' },

  // Edit (the title input).
  newBelow: { keys: ['Enter'], scope: 'edit', section: 'editing' },
  newAbove: { keys: ['Shift+Enter'], scope: 'edit', section: 'editing' },
  caretUp: { keys: ['ArrowUp'], scope: 'edit', section: 'editing' },
  caretDown: { keys: ['ArrowDown'], scope: 'edit', section: 'editing' },
  deleteEmpty: { keys: ['Backspace'], scope: 'edit', section: 'editing' },

  // Both modes.
  escape: { keys: ['Escape'], scope: 'list', section: 'navigation' },
  complete: { keys: ['Mod+Enter'], scope: 'list', section: 'editing' },
  deleteTask: { keys: ['Tab+Delete', 'Tab+Backspace'], scope: 'list', section: 'editing' },
  quickAdd: { keys: ['Tab+Q'], scope: 'list', section: 'editing' },
  datePicker: { keys: ['Tab+D'], scope: 'list', section: 'editing' },
  moveTo: { keys: ['Tab+M'], scope: 'list', section: 'moving' },
  moveUp: { keys: ['Mod+ArrowUp'], scope: 'list', section: 'moving' },
  moveDown: { keys: ['Mod+ArrowDown'], scope: 'list', section: 'moving' },
  moveToPreviousGroup: { keys: ['Mod+Shift+ArrowUp'], scope: 'list', section: 'moving' },
  moveToNextGroup: { keys: ['Mod+Shift+ArrowDown'], scope: 'list', section: 'moving' },
  moveToGroupTop: { keys: ['Alt+Shift+ArrowUp'], scope: 'list', section: 'moving' },
  moveToGroupBottom: { keys: ['Alt+Shift+ArrowDown'], scope: 'list', section: 'moving' },
  newGroup: { keys: ['Tab+N'], scope: 'list', section: 'groups' },
  renameGroup: { keys: ['F2'], scope: 'navigate', section: 'groups' },

  // Keyboard drag on a focused handle (02 §5).
  dragLift: { keys: ['Space'], scope: 'drag', section: 'moving' },
  dragMove: { keys: ['ArrowUp', 'ArrowDown'], scope: 'drag', section: 'moving' },
  dragJumpGroup: { keys: ['Ctrl+ArrowUp', 'Ctrl+ArrowDown'], scope: 'drag', section: 'moving' },
  dragCancel: { keys: ['Escape'], scope: 'drag', section: 'moving' },

  // Date popover quick chips (features/dates/quick-dates.ts matches them by code).
  dateToday: { keys: ['Alt+T'], scope: 'picker', section: 'dates' },
  dateTomorrow: { keys: ['Alt+M'], scope: 'picker', section: 'dates' },
  dateNextWeek: { keys: ['Alt+W'], scope: 'picker', section: 'dates' },
  dateWeekend: { keys: ['Alt+E'], scope: 'picker', section: 'dates' },
  dateNone: { keys: ['Alt+0'], scope: 'picker', section: 'dates' },
} as const satisfies Record<string, ShortcutDefinition>;

export type ShortcutId = keyof typeof keymap;

export const shortcutIds = Object.keys(keymap) as ShortcutId[];

/** The first (displayed) key combination of a shortcut. */
export function primaryKeys(id: ShortcutId): string {
  return keymap[id].keys[0];
}

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Symbols whose Shift state depends on the keyboard layout (`?` is Shift+/ in US, Shift++ in SV). */
const layoutSymbol = /^[^\p{L}\p{N}\s]$/u;

/** The `KeyboardEvent.key` for a registry key name. */
function eventKeyName(key: string): string {
  return key === 'Space' ? ' ' : key;
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
  if (event.altKey !== wants.has('Alt')) return false;
  const symbol = layoutSymbol.test(key) && key !== '\\';
  if (!symbol && event.shiftKey !== wants.has('Shift')) return false;
  // `code` keeps the shortcut working on layouts where "\" needs AltGr (e.g. Swedish).
  if (key === '\\') return event.key === '\\' || event.code === 'Backslash';
  // Digits by code: Shift or AltGr layers change `key` on many layouts.
  if (/^\d$/.test(key)) return event.key === key || event.code === `Digit${key}`;
  return event.key.toLowerCase() === eventKeyName(key).toLowerCase();
}

/** True when any alternative of the shortcut matches. */
export function matches(event: KeyEventLike, id: ShortcutId, platform: Platform): boolean {
  return keymap[id].keys.some(
    (keys: string) =>
      !keys.startsWith('Tab+') && !keys.includes(' ') && matchesShortcut(event, keys, platform),
  );
}

/** The chord key of a `Tab+X` alternative that matches the event pressed while Tab is held. */
export function matchesTabChord(event: KeyEventLike, id: ShortcutId, platform: Platform): boolean {
  return keymap[id].keys.some(
    (keys: string) =>
      keys.startsWith('Tab+') && matchesShortcut(event, keys.slice('Tab+'.length), platform),
  );
}

/** The `G X` alternative completed by `event` after a G. */
export function matchesSequence(event: KeyEventLike, id: ShortcutId): boolean {
  return keymap[id].keys.some((keys: string) => {
    const [first, second] = keys.split(' ');
    return (
      first === 'G' &&
      second !== undefined &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key.toLowerCase() === second.toLowerCase()
    );
  });
}

/** Ids whose scope is in `scopes`, in registry order. */
export function shortcutsIn(...scopes: ShortcutScope[]): ShortcutId[] {
  return shortcutIds.filter((id) => scopes.includes(keymap[id].scope));
}
