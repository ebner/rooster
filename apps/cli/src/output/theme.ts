import type { DueState } from '@rooster/core/dates';
import {
  dueDateColors,
  palette,
  type SemanticColorToken,
  semanticColors,
  type TagColor,
  tagPalette,
} from '@rooster/tokens';
import type { Style } from './color.ts';

/** A semantic Coop colour (03 §2.2) as hex. */
export function token(name: SemanticColorToken): string {
  return palette[semanticColors[name]];
}

/** 03 §2.3: the due label colour per `dueState()`; overdue is the one bold (weight 500) state. */
export function dueStyle(state: Exclude<DueState, 'none'>): Style {
  return { fg: palette[dueDateColors[state]], ...(state === 'overdue' ? { bold: true } : {}) };
}

/** A tag chip: the palette's background and text colours (03 §2.4). */
export function tagStyle(color: string): Style {
  const chip = tagPalette[color as TagColor] ?? tagPalette.gray;
  return { fg: chip.fg, bg: chip.bg };
}

export const styles = {
  muted: { fg: token('text-muted') },
  secondary: { fg: token('text-secondary') },
  heading: { bold: true },
  accent: { fg: token('text-accent'), bold: true },
  done: { fg: token('text-muted'), strike: true },
  check: { fg: token('check-done') },
  danger: { fg: token('text-danger'), bold: true },
  success: { fg: token('text-success') },
  warning: { fg: token('text-warning') },
  link: { fg: token('text-info'), underline: true },
} as const satisfies Record<string, Style>;
