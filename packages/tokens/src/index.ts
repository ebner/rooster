/**
 * Coop design tokens (docs/spec/03-design-system.md §2) as typed constants.
 *
 * `tokens.css` is the runtime source for the web app; these constants exist for
 * non-CSS consumers (TUI, email templates) and for the contrast tests. The test
 * suite asserts that both files agree, so change them together.
 */

/** Raw palette (03 §2.1). Only semantic tokens may reference these. */
export const palette = {
  'n-0': '#FFFFFF',
  'n-25': '#FBFCFD',
  'n-50': '#F6F7F9',
  'n-100': '#EEF0F3',
  'n-200': '#E2E5EA',
  'n-300': '#CDD2DA',
  'n-400': '#9AA3B0',
  'n-500': '#636B78',
  'n-600': '#4E5663',
  'n-700': '#3A404A',
  'n-800': '#262A31',
  'n-900': '#16191E',
  'coral-50': '#FFF3F1',
  'coral-100': '#FFE3DF',
  'coral-200': '#FFC9C2',
  'coral-300': '#FFA197',
  'coral-400': '#FA766A',
  'coral-500': '#EF4F45',
  'coral-600': '#D93A31',
  'coral-700': '#B42D26',
  'coral-800': '#8F251F',
  'coral-900': '#6E1F1A',
  'green-50': '#EEFBF2',
  'green-600': '#16A34A',
  'green-700': '#15803D',
  'amber-50': '#FFF8EB',
  'amber-500': '#F59E0B',
  'amber-700': '#B45309',
  'violet-700': '#6D28D9',
  'rose-50': '#FFF1F3',
  'rose-600': '#E11D48',
  'rose-700': '#BE123C',
  'blue-50': '#EFF6FF',
  'blue-700': '#1D4ED8',
} as const;

export type PaletteToken = keyof typeof palette;

/**
 * Semantic colours (03 §2.2), keyed by the CSS name without the `--color-` prefix.
 * Tokens beyond the spec table (inverse surfaces, danger/warning/info pairs) name
 * values the spec prescribes inline for specific components (tooltip, toast,
 * danger button, sync pill, Kbd).
 */
export const semanticColors = {
  'bg-app': 'n-0',
  'bg-sidebar': 'n-50',
  'bg-subtle': 'n-50',
  'bg-muted': 'n-100',
  'bg-elevated': 'n-0',
  'bg-selected': 'coral-50',
  'bg-accent': 'coral-600',
  'bg-accent-hover': 'coral-700',
  'bg-accent-subtle': 'coral-100',
  'bg-inbox': 'coral-50',
  'bg-success-subtle': 'green-50',
  'bg-warning-subtle': 'amber-50',
  'bg-danger-subtle': 'rose-50',
  'bg-info-subtle': 'blue-50',
  'bg-danger': 'rose-600',
  'bg-danger-hover': 'rose-700',
  'bg-inverse': 'n-900',
  'bg-inverse-muted': 'n-800',
  text: 'n-900',
  'text-secondary': 'n-600',
  'text-muted': 'n-500',
  'text-disabled': 'n-400',
  'text-on-accent': 'n-0',
  'text-on-danger': 'n-0',
  'text-accent': 'coral-600',
  'text-accent-hover': 'coral-700',
  'text-danger': 'rose-700',
  'text-success': 'green-700',
  'text-warning': 'amber-700',
  'text-info': 'blue-700',
  'text-inverse': 'n-0',
  'text-inverse-muted': 'n-300',
  'text-inverse-accent': 'coral-300',
  'icon-subtle': 'n-400',
  'icon-danger': 'rose-600',
  border: 'n-200',
  'border-strong': 'n-300',
  'border-hover': 'n-500',
  'border-focus': 'coral-500',
  'border-danger': 'rose-600',
  'border-inverse': 'n-600',
  'selection-bar': 'coral-500',
  'drop-indicator': 'coral-500',
  'drop-target-outline': 'coral-400',
  'check-done': 'green-600',
  brand: 'coral-500',
} as const satisfies Record<string, PaletteToken>;

export type SemanticColorToken = keyof typeof semanticColors;

/** Scrim colour; the only semantic colour that is not a palette reference. */
export const overlayColor = 'rgb(22 25 30 / 0.32)';

/** Due-date label colours (03 §2.3), keyed by `dueState()` result. */
export const dueDateColors = {
  overdue: 'rose-700',
  today: 'green-700',
  tomorrow: 'amber-700',
  thisWeek: 'violet-700',
  later: 'n-600',
  done: 'n-500',
} as const satisfies Record<string, PaletteToken>;

export type DueDateState = keyof typeof dueDateColors;

/** Tag palette (03 §2.4), in round-robin assignment order. */
export const tagColorNames = [
  'gray',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'purple',
  'pink',
] as const;

export type TagColor = (typeof tagColorNames)[number];

export const tagPalette = {
  gray: { bg: '#EEF0F3', fg: '#3A404A' },
  red: { bg: '#FFE4E6', fg: '#9F1239' },
  orange: { bg: '#FFEAD5', fg: '#9A3412' },
  amber: { bg: '#FEF3C7', fg: '#92400E' },
  green: { bg: '#DCFCE7', fg: '#166534' },
  teal: { bg: '#DDF6F3', fg: '#0F5F58' },
  blue: { bg: '#E0EDFF', fg: '#1E40AF' },
  indigo: { bg: '#E6E8FF', fg: '#3730A3' },
  purple: { bg: '#F1E8FF', fg: '#6B21A8' },
  pink: { bg: '#FCE7F3', fg: '#9D174D' },
} as const satisfies Record<TagColor, { bg: string; fg: string }>;

/** Typography (03 §2.5). Sizes and line heights in px. */
export const fontFamilies = {
  sans: '"Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: '"Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
} as const;

interface FontSizeToken {
  size: number;
  lineHeight: number;
  weight?: number;
  letterSpacing?: string;
}

const tightTracking = '-0.011em';

export const fontSizes = {
  xs: { size: 12, lineHeight: 16 },
  sm: { size: 13, lineHeight: 20 },
  base: { size: 14, lineHeight: 20 },
  md: { size: 16, lineHeight: 24 },
  group: { size: 16, lineHeight: 24, weight: 600 },
  lg: { size: 20, lineHeight: 28, weight: 600, letterSpacing: tightTracking },
  xl: { size: 24, lineHeight: 32, weight: 600, letterSpacing: tightTracking },
  '2xl': { size: 30, lineHeight: 38, weight: 600, letterSpacing: tightTracking },
} as const satisfies Record<string, FontSizeToken>;

export type FontSizeTokenName = keyof typeof fontSizes;

/** Spacing scale (03 §2.6), px. Keys mirror Tailwind steps; "." becomes "_" in CSS. */
export const spacing = {
  '0': 0,
  '0.5': 2,
  '1': 4,
  '1.5': 6,
  '2': 8,
  '3': 12,
  '4': 16,
  '5': 20,
  '6': 24,
  '8': 32,
  '10': 40,
  '12': 48,
  '16': 64,
} as const;

/** Component heights (03 §2.6 and §3), px. CSS: `--h-<name>`. */
export const heights = {
  'control-sm': 28,
  control: 32,
  'control-lg': 40,
  row: 40,
  'row-mobile': 52,
  'row-subtask': 36,
  group: 44,
  'group-mobile': 48,
  chip: 20,
  pill: 24,
  toolbar: 48,
  'sheet-header': 56,
  'property-row': 36,
  'property-row-mobile': 48,
  'bottom-nav': 64,
  'view-switcher': 48,
  'accessory-bar': 56,
  'sheet-handle': 4,
} as const;

/** Square sizes (03 §3), px. CSS: `--size-<name>`. */
export const sizes = {
  checkbox: 18,
  hit: 32,
  'hit-touch': 44,
  fab: 56,
  'calendar-cell': 36,
} as const;

/** Layout widths (03 §2.8, §3; D-27, D-29, D-29a), px. CSS: `--w-<name>`. */
export const layoutWidths = {
  'list-max': 1040,
  'list-min': 480,
  sidebar: 248,
  rail: 56,
  pane: 520,
  'pane-min': 400,
  'pane-max': 720,
  'pane-overlay': 480,
  'date-popover': 320,
  palette: 640,
  toast: 360,
  'date-cell': 112,
  'label-col': 112,
  illustration: 160,
  'sheet-handle': 36,
} as const;

/** Border widths that are not whole Tailwind steps, px. CSS: `--border-<name>`. */
export const borderWidths = {
  check: 1.5,
} as const;

/** Radii (03 §2.6), px. `full` is a pill. */
export const radii = {
  '2xs': 2,
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  full: 9999,
} as const;

/** Shadows (03 §2.6). */
export const shadows = {
  sm: '0 1px 2px rgb(22 25 30 / 0.06)',
  md: '0 4px 12px rgb(22 25 30 / 0.08), 0 1px 3px rgb(22 25 30 / 0.06)',
  lg: '0 12px 32px rgb(22 25 30 / 0.12), 0 2px 6px rgb(22 25 30 / 0.08)',
  pane: '-1px 0 0 var(--color-border)',
} as const;

/** Stacking order (03 §2.6). */
export const zIndex = {
  base: 0,
  sticky: 10,
  sidebar: 20,
  pane: 30,
  popover: 40,
  'bulk-bar': 45,
  toast: 50,
  palette: 60,
  drag: 70,
} as const;

/** Motion (03 §2.7), ms. `fade` is the opacity-only duration that survives reduced motion. */
export const durations = {
  fast: 120,
  base: 180,
  slow: 250,
  pop: 300,
  fade: 120,
  shimmer: 1200,
} as const;

/** Durations under `prefers-reduced-motion: reduce`: 0, except fades capped at 80 ms. */
export const reducedMotionDurations = {
  fast: 0,
  base: 0,
  slow: 0,
  pop: 0,
  fade: 80,
  shimmer: 0,
} as const satisfies Record<keyof typeof durations, number>;

export const easings = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const;

/** Breakpoints (03 §2.8, 02 §2), px: mobile < tablet ≤ … < desktop ≤ … < wide. */
export const breakpoints = {
  tablet: 768,
  desktop: 1200,
  wide: 1600,
} as const;

/** Resolves a semantic colour to its hex value. */
export function resolveColor(token: SemanticColorToken): string {
  return palette[semanticColors[token]];
}

/** Resolves a due-date state to its hex value. */
export function resolveDueDateColor(state: DueDateState): string {
  return palette[dueDateColors[state]];
}

const px = (value: number): string => `${value}px`;
const kebab = (value: string): string => value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const cssKey = (value: string): string => value.replace('.', '_');

/**
 * Every custom property `tokens.css` must declare on `:root`, with its exact value.
 * Used by the agreement test; also handy for generating CSS for emails.
 */
export function cssVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, hex] of Object.entries(palette)) vars[`--${name}`] = hex;
  for (const [name, ref] of Object.entries(semanticColors))
    vars[`--color-${name}`] = `var(--${ref})`;
  vars['--color-overlay'] = overlayColor;
  for (const [state, ref] of Object.entries(dueDateColors)) {
    vars[`--color-date-${kebab(state)}`] = `var(--${ref})`;
  }
  for (const [name, pair] of Object.entries(tagPalette)) {
    vars[`--tag-${name}-bg`] = pair.bg;
    vars[`--tag-${name}-fg`] = pair.fg;
  }
  vars['--font-sans'] = fontFamilies.sans;
  vars['--font-mono'] = fontFamilies.mono;
  for (const [name, token] of Object.entries(fontSizes) as [string, FontSizeToken][]) {
    vars[`--text-${name}`] = px(token.size);
    vars[`--text-${name}--line-height`] = px(token.lineHeight);
    if (token.weight !== undefined) vars[`--text-${name}--font-weight`] = String(token.weight);
    if (token.letterSpacing !== undefined) {
      vars[`--text-${name}--letter-spacing`] = token.letterSpacing;
    }
  }
  for (const [name, value] of Object.entries(spacing)) vars[`--space-${cssKey(name)}`] = px(value);
  for (const [name, value] of Object.entries(heights)) vars[`--h-${name}`] = px(value);
  for (const [name, value] of Object.entries(sizes)) vars[`--size-${name}`] = px(value);
  for (const [name, value] of Object.entries(layoutWidths)) vars[`--w-${name}`] = px(value);
  for (const [name, value] of Object.entries(borderWidths)) vars[`--border-${name}`] = px(value);
  for (const [name, value] of Object.entries(radii)) vars[`--radius-${name}`] = px(value);
  for (const [name, value] of Object.entries(shadows)) vars[`--shadow-${name}`] = value;
  for (const [name, value] of Object.entries(zIndex)) vars[`--z-${name}`] = String(value);
  for (const [name, value] of Object.entries(durations)) vars[`--dur-${name}`] = `${value}ms`;
  for (const [name, value] of Object.entries(easings)) vars[`--ease-${name}`] = value;
  for (const [name, value] of Object.entries(breakpoints)) vars[`--bp-${name}`] = px(value);
  return vars;
}

/** Custom properties redeclared inside `@media (prefers-reduced-motion: reduce)`. */
export function reducedMotionCssVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(reducedMotionDurations)) {
    vars[`--dur-${name}`] = `${value}ms`;
  }
  return vars;
}
