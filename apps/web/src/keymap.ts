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
 * - `list`: list keys in both modes (modifier chords and Tab chords). They also work with focus
 *   in the detail pane, where they act on the pane's task.
 * - `edit`: handled by the focused title input itself.
 * - `drag`: handled by a focused drag handle.
 * - `picker`: handled inside the date popover (matched by `event.code`, 02 §7).
 * - `editor`: handled by the description editor itself (features/editor, 02 §9.2).
 * - `composer`: handled by the comment composer itself (features/collab, 02 §9.2 item 8). Its
 *   Tab+Enter arrives as the `openPaneFocus` chord, which the pane turns into "post".
 * - `palette`: no keys; a command only the palette runs (`keys: []`, skipped by the cheat sheet).
 * - `lightbox`: handled by the attachment lightbox itself (features/attachments, P10).
 */
export type ShortcutScope =
  | 'global'
  | 'navigate'
  | 'list'
  | 'edit'
  | 'drag'
  | 'picker'
  | 'editor'
  | 'composer'
  | 'palette'
  | 'lightbox';

/**
 * Where a command appears in the command palette (04 §5.3, FR-VIEW-4); entries without it are
 * not offered there. `task` commands act on the list's selection and only show with one.
 */
export type PaletteGroup = 'task' | 'list' | 'navigation' | 'general';

export type ShortcutSection =
  | 'general'
  | 'navigation'
  | 'editing'
  | 'moving'
  | 'groups'
  | 'pane'
  | 'editor'
  | 'dates'
  | 'inbox';

export interface ShortcutDefinition {
  /** Alternatives; the first is the one shown in tooltips and menus. */
  keys: readonly string[];
  scope: ShortcutScope;
  section: ShortcutSection;
  /** Cheat-sheet label override, e.g. `Mod+1…9` for a range. */
  display?: string;
  /** Offered as a palette action (labelled `palette:action.<id>`), run via `runShortcut`. */
  palette?: PaletteGroup;
}

export const keymap = {
  // Global (modifier chords only, work even while typing).
  search: { keys: ['Mod+K'], scope: 'global', section: 'general' },
  toggleSidebar: { keys: ['Mod+\\'], scope: 'global', section: 'general', palette: 'general' },
  goToOrg: {
    keys: ['Mod+1', 'Mod+2', 'Mod+3', 'Mod+4', 'Mod+5', 'Mod+6', 'Mod+7', 'Mod+8', 'Mod+9'],
    scope: 'global',
    section: 'general',
    display: 'Mod+1…9',
  },
  undo: { keys: ['Mod+Z'], scope: 'global', section: 'general', palette: 'general' },
  redo: {
    keys: ['Mod+Shift+Z', 'Ctrl+Y'],
    scope: 'global',
    section: 'general',
    palette: 'general',
  },
  cheatSheet: { keys: ['?'], scope: 'navigate', section: 'general', palette: 'general' },
  goMyTasks: { keys: ['G M'], scope: 'navigate', section: 'general', palette: 'navigation' },
  goSettings: { keys: ['G S'], scope: 'navigate', section: 'general', palette: 'navigation' },
  goToday: { keys: ['G T'], scope: 'navigate', section: 'general', palette: 'navigation' },
  goWeek: { keys: ['G W'], scope: 'navigate', section: 'general', palette: 'navigation' },
  goOverdue: { keys: ['G O'], scope: 'navigate', section: 'general', palette: 'navigation' },
  goNoDate: { keys: ['G N'], scope: 'navigate', section: 'general', palette: 'navigation' },
  goEveryone: { keys: ['G E'], scope: 'navigate', section: 'general', palette: 'navigation' },
  goInbox: { keys: ['G I'], scope: 'navigate', section: 'general', palette: 'navigation' },
  // P11 (ADR 0052 §2): the user guide at /help.
  goHelp: { keys: ['G H'], scope: 'navigate', section: 'general', palette: 'navigation' },
  focusSearch: { keys: ['/'], scope: 'navigate', section: 'general' },

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
  toggleCompleted: { keys: ['Shift+H'], scope: 'navigate', section: 'navigation', palette: 'list' },
  editTitle: { keys: ['Enter', 'F2', 'I'], scope: 'navigate', section: 'editing' },
  newBelowNavigate: { keys: ['N'], scope: 'navigate', section: 'editing' },
  newAboveNavigate: { keys: ['Shift+N'], scope: 'navigate', section: 'editing' },
  quickAddNavigate: { keys: ['Q'], scope: 'navigate', section: 'editing' },
  dateNavigate: { keys: ['D'], scope: 'navigate', section: 'editing' },
  moveToNavigate: { keys: ['M'], scope: 'navigate', section: 'moving' },
  deleteNavigate: { keys: ['Delete', 'Backspace'], scope: 'navigate', section: 'editing' },
  addSubtaskNavigate: { keys: ['S'], scope: 'navigate', section: 'editing' },
  tagPickerNavigate: { keys: ['T', '#'], scope: 'navigate', section: 'editing' },
  assignNavigate: { keys: ['A'], scope: 'navigate', section: 'editing' },
  commentNavigate: { keys: ['C'], scope: 'navigate', section: 'pane' },
  openPane: { keys: ['O'], scope: 'navigate', section: 'pane' },
  peekPane: { keys: ['Space'], scope: 'navigate', section: 'pane' },

  // Edit (the title input).
  newBelow: { keys: ['Enter'], scope: 'edit', section: 'editing' },
  newAbove: { keys: ['Shift+Enter'], scope: 'edit', section: 'editing' },
  caretUp: { keys: ['ArrowUp'], scope: 'edit', section: 'editing' },
  caretDown: { keys: ['ArrowDown'], scope: 'edit', section: 'editing' },
  deleteEmpty: { keys: ['Backspace'], scope: 'edit', section: 'editing' },

  // Both modes.
  escape: { keys: ['Escape'], scope: 'list', section: 'navigation' },
  complete: { keys: ['Mod+Enter'], scope: 'list', section: 'editing', palette: 'task' },
  deleteTask: {
    keys: ['Tab+Delete', 'Tab+Backspace'],
    scope: 'list',
    section: 'editing',
    palette: 'task',
  },
  quickAdd: { keys: ['Tab+Q'], scope: 'list', section: 'editing', palette: 'list' },
  datePicker: { keys: ['Tab+D'], scope: 'list', section: 'editing', palette: 'task' },
  moveTo: { keys: ['Tab+M'], scope: 'list', section: 'moving', palette: 'task' },
  moveUp: { keys: ['Mod+ArrowUp'], scope: 'list', section: 'moving', palette: 'task' },
  moveDown: { keys: ['Mod+ArrowDown'], scope: 'list', section: 'moving', palette: 'task' },
  moveToPreviousGroup: { keys: ['Mod+Shift+ArrowUp'], scope: 'list', section: 'moving' },
  moveToNextGroup: { keys: ['Mod+Shift+ArrowDown'], scope: 'list', section: 'moving' },
  moveToGroupTop: {
    keys: ['Alt+Shift+ArrowUp'],
    scope: 'list',
    section: 'moving',
    palette: 'task',
  },
  moveToGroupBottom: {
    keys: ['Alt+Shift+ArrowDown'],
    scope: 'list',
    section: 'moving',
    palette: 'task',
  },
  newGroup: { keys: ['Tab+N'], scope: 'list', section: 'groups', palette: 'list' },
  addSubtask: { keys: ['Tab+S'], scope: 'list', section: 'editing', palette: 'task' },
  tagPicker: { keys: ['Tab+T'], scope: 'list', section: 'editing', palette: 'task' },
  duplicate: { keys: ['Mod+D'], scope: 'list', section: 'editing', palette: 'task' },
  openPaneFocus: { keys: ['Tab+Enter'], scope: 'list', section: 'pane', palette: 'task' },
  paneFullScreen: { keys: ['Tab+X'], scope: 'list', section: 'pane' },
  focusDescription: { keys: ['Tab+R'], scope: 'list', section: 'pane' },
  assign: { keys: ['Tab+A'], scope: 'list', section: 'editing', palette: 'task' },
  focusComment: { keys: ['Tab+C'], scope: 'list', section: 'pane', palette: 'task' },
  renameGroup: { keys: ['F2'], scope: 'navigate', section: 'groups' },

  // Keyboard drag on a focused handle (02 §5).
  dragLift: { keys: ['Space'], scope: 'drag', section: 'moving' },
  dragMove: { keys: ['ArrowUp', 'ArrowDown'], scope: 'drag', section: 'moving' },
  dragJumpGroup: { keys: ['Ctrl+ArrowUp', 'Ctrl+ArrowDown'], scope: 'drag', section: 'moving' },
  dragCancel: { keys: ['Escape'], scope: 'drag', section: 'moving' },

  // The description editor (features/editor binds the same keys).
  editorBold: { keys: ['Mod+B'], scope: 'editor', section: 'editor' },
  editorItalic: { keys: ['Mod+I'], scope: 'editor', section: 'editor' },
  editorStrike: { keys: ['Mod+Shift+S'], scope: 'editor', section: 'editor' },
  editorCode: { keys: ['Mod+E'], scope: 'editor', section: 'editor' },
  editorLink: { keys: ['Mod+K'], scope: 'editor', section: 'editor' },
  editorToolbar: { keys: ['Alt+F10'], scope: 'editor', section: 'editor' },

  // The comment composer (features/collab binds them; 02 §9.2 item 8).
  postComment: { keys: ['Mod+Enter', 'Tab+Enter'], scope: 'composer', section: 'pane' },

  // Attachments (P10, FR-ATT; features/attachments): attach in the pane, and the lightbox.
  attachFile: { keys: ['Tab+U'], scope: 'list', section: 'pane' },
  lightboxPrevious: { keys: ['ArrowLeft'], scope: 'lightbox', section: 'pane' },
  lightboxNext: { keys: ['ArrowRight'], scope: 'lightbox', section: 'pane' },
  lightboxClose: { keys: ['Escape'], scope: 'lightbox', section: 'pane' },

  // The inbox (FR-NOT-1); ↑/↓ (K/J), Home/End move between notifications, Enter opens one.
  toggleRead: { keys: ['U'], scope: 'navigate', section: 'inbox' },
  markAllRead: { keys: ['Shift+U'], scope: 'navigate', section: 'inbox' },

  // Date popover quick chips (features/dates/quick-dates.ts matches them by code).
  dateToday: { keys: ['Alt+T'], scope: 'picker', section: 'dates' },
  dateTomorrow: { keys: ['Alt+M'], scope: 'picker', section: 'dates' },
  dateNextWeek: { keys: ['Alt+W'], scope: 'picker', section: 'dates' },
  dateWeekend: { keys: ['Alt+E'], scope: 'picker', section: 'dates' },
  dateNone: { keys: ['Alt+0'], scope: 'picker', section: 'dates' },
  // P10 (02 §7): opens the picker's reminder section.
  dateReminder: { keys: ['Alt+R'], scope: 'picker', section: 'dates' },

  // Palette-only commands (no keys; the palette registers their handlers).
  makeSubtaskOf: { keys: [], scope: 'palette', section: 'editing', palette: 'task' },
  openTrash: { keys: [], scope: 'palette', section: 'general', palette: 'navigation' },
  exportData: { keys: [], scope: 'palette', section: 'general', palette: 'navigation' },
  openOrgSettings: { keys: [], scope: 'palette', section: 'general', palette: 'navigation' },
  openAdmin: { keys: [], scope: 'palette', section: 'general', palette: 'navigation' },
} as const satisfies Record<string, ShortcutDefinition>;

export type ShortcutId = keyof typeof keymap;

export const shortcutIds = Object.keys(keymap) as ShortcutId[];

type PaletteOnlyId = {
  [K in ShortcutId]: (typeof keymap)[K]['scope'] extends 'palette' ? K : never;
}[ShortcutId];

/** Registry entries bound to keys (the cheat sheet documents exactly these). */
export type KeyedShortcutId = Exclude<ShortcutId, PaletteOnlyId>;

export function isKeyed(id: ShortcutId): id is KeyedShortcutId {
  return keymap[id].scope !== 'palette';
}

/** The first (displayed) key combination of a shortcut; empty for palette-only commands. */
export function primaryKeys(id: ShortcutId): string {
  const keys: readonly string[] = keymap[id].keys;
  return keys[0] ?? '';
}

/** Registry entries offered as palette actions. */
export type PaletteCommandId = {
  [K in ShortcutId]: (typeof keymap)[K] extends { palette: PaletteGroup } ? K : never;
}[ShortcutId];

/** The palette group of a registry entry (undefined: not a palette action). */
export function paletteGroupOf(id: ShortcutId): PaletteGroup | undefined {
  const definition: ShortcutDefinition = keymap[id];
  return definition.palette;
}

/** Palette actions in registry order (04 §5.3: generated from the registry). */
export const paletteCommandIds = shortcutIds.filter(
  (id): id is PaletteCommandId => paletteGroupOf(id) !== undefined,
);

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

/** The order of the sections in the `?` cheat sheet and the generated keyboard page. */
export const shortcutSections: readonly ShortcutSection[] = [
  'general',
  'navigation',
  'editing',
  'moving',
  'groups',
  'pane',
  'editor',
  'dates',
  'inbox',
];

/**
 * Registry entries per section, in registry order: what the `?` cheat sheet and the guide's
 * keyboard page (`pnpm docs:keyboard`) document. Palette-only commands have no keys and are
 * left out.
 */
export function keyedShortcutsBySection(): { section: ShortcutSection; ids: KeyedShortcutId[] }[] {
  const keyed = shortcutIds.filter(isKeyed);
  return shortcutSections.map((section) => ({
    section,
    ids: keyed.filter((id) => keymap[id].section === section),
  }));
}

/** Ids whose scope is in `scopes`, in registry order. */
export function shortcutsIn(...scopes: ShortcutScope[]): ShortcutId[] {
  return shortcutIds.filter((id) => scopes.includes(keymap[id].scope));
}
