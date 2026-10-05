import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  cssVariables,
  type DueDateState,
  dueDateColors,
  palette,
  reducedMotionCssVariables,
  resolveColor,
  resolveDueDateColor,
  type SemanticColorToken,
  tagColorNames,
  tagPalette,
} from '../src/index.ts';

const MIN_TEXT_CONTRAST = 4.5;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG 2.x contrast ratio between two opaque sRGB hex colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every text/background pair the UI is allowed to use (03 §2.2–§2.4, §3).
 * Add a pair here before using it in a component.
 */
const allowedPairs: [fg: SemanticColorToken, bg: SemanticColorToken][] = [
  ...(['text', 'text-secondary', 'text-muted'] as const).flatMap((fg) =>
    (['bg-app', 'bg-sidebar', 'bg-subtle', 'bg-selected', 'bg-elevated'] as const).map(
      (bg) => [fg, bg] as [SemanticColorToken, SemanticColorToken],
    ),
  ),
  ['text', 'bg-muted'],
  ['text-secondary', 'bg-muted'],
  ['text', 'bg-accent-subtle'],
  ['text-secondary', 'bg-accent-subtle'],
  ['text', 'bg-inbox'],
  ['text-secondary', 'bg-inbox'],
  ['text-muted', 'bg-inbox'],
  ['text-on-accent', 'bg-accent'],
  ['text-on-accent', 'bg-accent-hover'],
  ['text-on-danger', 'bg-danger'],
  ['text-on-danger', 'bg-danger-hover'],
  ['text-accent', 'bg-app'],
  ['text-accent-hover', 'bg-app'],
  ['text-danger', 'bg-app'],
  ['text-danger', 'bg-danger-subtle'],
  ['text-danger', 'bg-muted'],
  ['text-success', 'bg-app'],
  ['text-success', 'bg-success-subtle'],
  ['text-warning', 'bg-app'],
  ['text-warning', 'bg-warning-subtle'],
  ['text-info', 'bg-app'],
  ['text-info', 'bg-info-subtle'],
  ['text-inverse', 'bg-inverse'],
  ['text-inverse-muted', 'bg-inverse'],
  ['text-inverse-accent', 'bg-inverse'],
  ['text-inverse', 'bg-inverse-muted'],
  ['text-inverse-muted', 'bg-inverse-muted'],
  ['text-inverse-accent', 'bg-inverse-muted'],
];

describe('WCAG contrast of allowed pairs (03 §4 contrast rule)', () => {
  test.each(allowedPairs)('%s on %s ≥ 4.5:1', (fg, bg) => {
    expect(contrast(resolveColor(fg), resolveColor(bg))).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  const labelStates = Object.keys(dueDateColors) as DueDateState[];
  test.each(labelStates)('due-date colour %s on bg-app and bg-subtle ≥ 4.5:1', (state) => {
    for (const bg of ['bg-app', 'bg-subtle', 'bg-selected'] as const) {
      expect(contrast(resolveDueDateColor(state), resolveColor(bg))).toBeGreaterThanOrEqual(
        MIN_TEXT_CONTRAST,
      );
    }
  });

  test.each(tagColorNames)('tag %s fg on bg ≥ 4.5:1', (name) => {
    const pair = tagPalette[name];
    expect(contrast(pair.fg, pair.bg)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  test('coral-600 on white matches the spec (4.57:1)', () => {
    expect(contrast(palette['coral-600'], palette['n-0'])).toBeCloseTo(4.57, 1);
  });

  test('focus ring and check fill reach the 3:1 non-text minimum on bg-app', () => {
    expect(contrast(resolveColor('border-focus'), resolveColor('bg-app'))).toBeGreaterThanOrEqual(
      3,
    );
    expect(contrast(resolveColor('check-done'), resolveColor('bg-app'))).toBeGreaterThanOrEqual(3);
    expect(
      contrast(resolveColor('text-inverse'), resolveColor('check-done')),
    ).toBeGreaterThanOrEqual(3);
  });
});

function parseCustomProperties(block: string): Map<string, string> {
  const result = new Map<string, string>();
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    // Case-insensitive: the formatter lower-cases hex colours in CSS.
    if (name && value) result.set(name, value.trim().replace(/\s+/g, ' ').toLowerCase());
  }
  return result;
}

const lowerValues = (vars: Record<string, string>) =>
  Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.toLowerCase()]));

describe('tokens.css and index.ts agree', () => {
  const css = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');
  const mediaStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
  const rootBlock = css.slice(0, mediaStart);
  const reducedBlock = css.slice(mediaStart);

  test('the :root block declares exactly the TS tokens with identical values', () => {
    const declared = Object.fromEntries(parseCustomProperties(rootBlock));
    expect(declared).toEqual(lowerValues(cssVariables()));
  });

  test('the reduced-motion block zeroes durations and caps fades at 80 ms', () => {
    expect(mediaStart).toBeGreaterThan(0);
    const declared = Object.fromEntries(parseCustomProperties(reducedBlock));
    expect(declared).toEqual(lowerValues(reducedMotionCssVariables()));
    expect(declared['--dur-fade']).toBe('80ms');
  });

  test('semantic tokens only reference palette tokens that exist', () => {
    for (const [name, value] of Object.entries(cssVariables())) {
      for (const ref of value.matchAll(/var\((--[\w-]+)\)/g)) {
        expect(cssVariables(), `${name} references ${ref[1]}`).toHaveProperty([ref[1] ?? '']);
      }
    }
  });
});
