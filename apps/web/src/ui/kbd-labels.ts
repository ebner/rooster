import type { Platform } from '../lib/platform';

/*
 * Key names and their labels per platform, without React: the `Kbd` component and the
 * generated keyboard page of the guide (`pnpm docs:keyboard`, run by plain Node) share them.
 */

export type SpokenKey =
  | 'kbd.command'
  | 'kbd.control'
  | 'kbd.option'
  | 'kbd.alt'
  | 'kbd.shift'
  | 'kbd.enter'
  | 'kbd.escape'
  | 'kbd.backspace'
  | 'kbd.tab'
  | 'kbd.up'
  | 'kbd.down'
  | 'kbd.left'
  | 'kbd.right';

export interface KeyLabel {
  mac: string;
  other: string;
  spoken?: { mac: SpokenKey; other: SpokenKey };
}

const same = (label: string, spoken: SpokenKey): KeyLabel => ({
  mac: label,
  other: label,
  spoken: { mac: spoken, other: spoken },
});

/** Key names follow `KeyboardEvent.key`; `Mod` is ⌘ on Apple platforms and Ctrl elsewhere. */
export const keyLabels: Record<string, KeyLabel> = {
  Mod: { mac: '⌘', other: 'Ctrl', spoken: { mac: 'kbd.command', other: 'kbd.control' } },
  Ctrl: { mac: '⌃', other: 'Ctrl', spoken: { mac: 'kbd.control', other: 'kbd.control' } },
  Alt: { mac: '⌥', other: 'Alt', spoken: { mac: 'kbd.option', other: 'kbd.alt' } },
  Shift: { mac: '⇧', other: 'Shift', spoken: { mac: 'kbd.shift', other: 'kbd.shift' } },
  Enter: { mac: '↵', other: 'Enter', spoken: { mac: 'kbd.enter', other: 'kbd.enter' } },
  Escape: { mac: 'Esc', other: 'Esc', spoken: { mac: 'kbd.escape', other: 'kbd.escape' } },
  Backspace: {
    mac: '⌫',
    other: 'Backspace',
    spoken: { mac: 'kbd.backspace', other: 'kbd.backspace' },
  },
  Tab: { mac: '⇥', other: 'Tab', spoken: { mac: 'kbd.tab', other: 'kbd.tab' } },
  ArrowUp: same('↑', 'kbd.up'),
  ArrowDown: same('↓', 'kbd.down'),
  ArrowLeft: same('←', 'kbd.left'),
  ArrowRight: same('→', 'kbd.right'),
};

/** Visible labels for a shortcut such as `"Mod+Shift+K"`. */
export function formatShortcut(shortcut: string, platform: Platform): string[] {
  return shortcut.split('+').map((key) => {
    const label = keyLabels[key];
    if (label) return label[platform];
    return key.length === 1 ? key.toUpperCase() : key;
  });
}

/** ⌘K on Apple platforms (no separator), Ctrl+K elsewhere. */
export function shortcutLabel(shortcut: string, platform: Platform): string {
  return formatShortcut(shortcut, platform).join(platform === 'mac' ? '' : '+');
}
