import { cva } from 'class-variance-authority';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { detectPlatform, type Platform } from '../lib/platform';

type SpokenKey =
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

interface KeyLabel {
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
const keyLabels: Record<string, KeyLabel> = {
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

const kbdVariants = cva(
  'inline-flex h-chip min-w-5 shrink-0 items-center justify-center rounded-xs border border-b-2 px-1 font-mono text-xs font-medium tabular-nums',
  {
    variants: {
      variant: {
        default: 'border-border-strong bg-bg-subtle text-text-secondary',
        inverse: 'border-border-inverse bg-bg-inverse-muted text-text-inverse',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface KbdProps {
  /** `KeyboardEvent.key` names joined with "+", e.g. `"Mod+K"`, `"Shift+Enter"`, `"?"`. */
  shortcut: string;
  /** Defaults to the current device; set it to preview another platform. */
  platform?: Platform;
  variant?: 'default' | 'inverse';
  className?: string | undefined;
}

/** 03 §3.14: platform-aware keyboard hint. Screen readers hear the spelled-out keys. */
export function Kbd({ shortcut, platform, variant, className }: KbdProps) {
  const { t } = useTranslation();
  const resolved = useMemo(() => platform ?? detectPlatform(), [platform]);
  const spoken = shortcut
    .split('+')
    .map((key) => {
      const label = keyLabels[key];
      return label?.spoken ? t(label.spoken[resolved]) : key.length === 1 ? key.toUpperCase() : key;
    })
    .join('+');
  return (
    <kbd className={cn(kbdVariants({ variant }), className)}>
      <span aria-hidden>{shortcutLabel(shortcut, resolved)}</span>
      <span className="sr-only">{spoken}</span>
    </kbd>
  );
}
