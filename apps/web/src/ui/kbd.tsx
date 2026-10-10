import { cva } from 'class-variance-authority';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { detectPlatform, type Platform } from '../lib/platform';
import { keyLabels, shortcutLabel } from './kbd-labels';

export { formatShortcut, shortcutLabel } from './kbd-labels';

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
