import type { ListView } from './model.ts';

/**
 * The TUI keymap (07 §5): the single table that both dispatches keys in Navigate mode and
 * generates the `?` help, like the web's `keymap.ts` (02 §6). Keys deliberately differ from the
 * web where terminals cannot tell the web's chords apart (Ctrl+Enter, Ctrl+J and Enter are one
 * byte); each such binding names its web equivalent, and the help lists them.
 */

/** The subset of Ink's `Key` the keymap reads. */
export interface KeyInfo {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
}

export type CommandId =
  | 'down'
  | 'up'
  | 'collapse'
  | 'expand'
  | 'first'
  | 'last'
  | 'edit'
  | 'newBelow'
  | 'newAbove'
  | 'complete'
  | 'date'
  | 'tag'
  | 'move'
  | 'subtask'
  | 'detail'
  | 'description'
  | 'moveDown'
  | 'moveUp'
  | 'nextGroup'
  | 'prevGroup'
  | 'delete'
  | 'undo'
  | 'redo'
  | 'search'
  | 'go'
  | 'org'
  | 'showCompleted'
  | 'retry'
  | 'scrollDown'
  | 'scrollUp'
  | 'help'
  | 'close'
  | 'quit';

export interface Binding {
  id: CommandId;
  /** How the keys are written in the help and the footer. */
  keys: string;
  match: (input: string, key: KeyInfo) => boolean;
  /**
   * The web's keys when they differ (shown under "Differences from the web"); `null` when the
   * web has no such key at all.
   */
  web?: string | null;
}

const plain = (key: KeyInfo) => !key.ctrl && !key.meta;
const char = (c: string) => (input: string, key: KeyInfo) => plain(key) && input === c;

export const KEYMAP: readonly Binding[] = [
  { id: 'down', keys: 'j ↓', match: (i, k) => k.downArrow || char('j')(i, k) },
  { id: 'up', keys: 'k ↑', match: (i, k) => k.upArrow || char('k')(i, k) },
  { id: 'collapse', keys: '←', match: (_, k) => k.leftArrow },
  { id: 'expand', keys: '→', match: (_, k) => k.rightArrow },
  { id: 'first', keys: 'Home', match: (_, k) => k.home },
  { id: 'last', keys: 'End', match: (_, k) => k.end },
  { id: 'edit', keys: 'Enter i', match: (i, k) => k.return || char('i')(i, k) },
  { id: 'newBelow', keys: 'n', match: char('n') },
  { id: 'newAbove', keys: 'N', match: char('N') },
  { id: 'complete', keys: 'x', match: char('x'), web: 'Ctrl+Enter' },
  { id: 'date', keys: 'd', match: char('d') },
  { id: 'tag', keys: 't', match: char('t') },
  { id: 'move', keys: 'm', match: char('m') },
  { id: 'subtask', keys: 's', match: char('s') },
  { id: 'detail', keys: 'o', match: char('o') },
  { id: 'description', keys: 'e', match: char('e'), web: 'Tab+R' },
  { id: 'moveDown', keys: 'J', match: char('J'), web: 'Ctrl+↓' },
  { id: 'moveUp', keys: 'K', match: char('K'), web: 'Ctrl+↑' },
  { id: 'nextGroup', keys: ']', match: char(']'), web: 'Ctrl+Shift+↓' },
  { id: 'prevGroup', keys: '[', match: char('['), web: 'Ctrl+Shift+↑' },
  { id: 'delete', keys: 'Delete', match: (_, k) => k.delete },
  { id: 'undo', keys: 'u', match: char('u'), web: 'Ctrl+Z' },
  { id: 'redo', keys: 'Ctrl+R', match: (i, k) => k.ctrl && i === 'r', web: 'Ctrl+Shift+Z' },
  { id: 'search', keys: '/', match: char('/') },
  { id: 'go', keys: 'g', match: char('g') },
  { id: 'org', keys: '1–9', match: (i, k) => plain(k) && /^[1-9]$/.test(i), web: 'Ctrl+1…9' },
  { id: 'showCompleted', keys: 'H', match: char('H') },
  { id: 'retry', keys: 'r', match: char('r'), web: null },
  { id: 'scrollDown', keys: 'PgDn', match: (_, k) => k.pageDown },
  { id: 'scrollUp', keys: 'PgUp', match: (_, k) => k.pageUp },
  { id: 'help', keys: '?', match: char('?') },
  { id: 'close', keys: 'Esc', match: (_, k) => k.escape },
  {
    id: 'quit',
    keys: 'q Ctrl+C',
    match: (i, k) => char('q')(i, k) || (k.ctrl && i === 'c'),
    web: null,
  },
];

/** `g` then one of these switches the view (02 §6 "G then M / T / W / O / N / E"). */
export const GO_KEYS: Readonly<Record<string, ListView>> = {
  m: 'my',
  t: 'today',
  w: 'week',
  o: 'overdue',
  n: 'nodate',
  e: 'everyone',
};

/** The web's `g` sequence waits this long for the second key (02 §6). */
export const GO_TIMEOUT_MS = 1_000;

export function commandFor(input: string, key: KeyInfo): CommandId | null {
  for (const binding of KEYMAP) if (binding.match(input, key)) return binding.id;
  return null;
}

/** The footer's key hints, most useful first; cut to the terminal width. */
export const FOOTER: readonly CommandId[] = [
  'down',
  'edit',
  'newBelow',
  'complete',
  'date',
  'move',
  'detail',
  'undo',
  'search',
  'help',
  'quit',
];

export function bindingOf(id: CommandId): Binding {
  return KEYMAP.find((b) => b.id === id) as Binding;
}
