/**
 * Terminal colour from Coop hex tokens (07 §4.1): truecolor when the terminal says so, else
 * the nearest xterm-256 or basic ANSI colour; none for `NO_COLOR`, `--no-color` or a pipe.
 */

/** 0 none, 1 basic 16 colours, 2 xterm-256, 3 truecolor. */
export type ColorLevel = 0 | 1 | 2 | 3;

export function colorLevel(
  env: Readonly<Record<string, string | undefined>>,
  isTTY: boolean,
  noColorFlag: boolean,
): ColorLevel {
  if (noColorFlag) return 0;
  // https://no-color.org: any non-empty value disables colour.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0;
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== '') {
    if (force === '0' || force === 'false') return 0;
    if (force === '2') return 2;
    if (force === '3') return 3;
    return isTTY ? detect(env) : 1;
  }
  if (!isTTY) return 0;
  return detect(env);
}

function detect(env: Readonly<Record<string, string | undefined>>): ColorLevel {
  if (env.TERM === 'dumb') return 0;
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3;
  if (env.WT_SESSION !== undefined) return 3;
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm') return 3;
  if (/-256(color)?$/i.test(env.TERM ?? '')) return 2;
  return 1;
}

type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const value = hex.replace(/^#/, '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

const distance = (a: Rgb, b: Rgb) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

const CUBE: readonly number[] = [0, 95, 135, 175, 215, 255];

/** The nearest xterm-256 index (6×6×6 cube or grey ramp). */
export function toAnsi256(rgb: Rgb): number {
  const step = (i: number) => CUBE[i] ?? 0;
  const nearestStep = (v: number) =>
    CUBE.reduce((best, value, i) => (Math.abs(value - v) < Math.abs(step(best) - v) ? i : best), 0);
  const [r, g, b] = rgb.map(nearestStep) as [number, number, number];
  const cubeIndex = 16 + 36 * r + 6 * g + b;
  const cubeRgb: Rgb = [step(r), step(g), step(b)];
  const avg = Math.round((rgb[0] + rgb[1] + rgb[2]) / 3);
  const greyStep = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const greyValue = 8 + greyStep * 10;
  const greyRgb: Rgb = [greyValue, greyValue, greyValue];
  return distance(greyRgb, rgb) < distance(cubeRgb, rgb) ? 232 + greyStep : cubeIndex;
}

/** The 16 basic colours (xterm defaults), as SGR foreground codes 30–37 and 90–97. */
const BASIC: readonly (readonly [number, Rgb])[] = [
  [30, [0, 0, 0]],
  [31, [205, 0, 0]],
  [32, [0, 205, 0]],
  [33, [205, 205, 0]],
  [34, [0, 0, 238]],
  [35, [205, 0, 205]],
  [36, [0, 205, 205]],
  [37, [229, 229, 229]],
  [90, [127, 127, 127]],
  [91, [255, 0, 0]],
  [92, [0, 255, 0]],
  [93, [255, 255, 0]],
  [94, [92, 92, 255]],
  [95, [255, 0, 255]],
  [96, [0, 255, 255]],
  [97, [255, 255, 255]],
];

/**
 * The nearest basic colour by hue family rather than raw distance: dark tokens (rose-700,
 * green-700) would otherwise all collapse to black or grey. Greys stay grey.
 */
export function toAnsi16(rgb: Rgb): number {
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  if (max - min < 40) {
    const level = (rgb[0] + rgb[1] + rgb[2]) / 3;
    if (level < 64) return 30;
    if (level < 170) return 90;
    return level < 240 ? 37 : 97;
  }
  // Saturate: scale the colour so its strongest channel is 205, then pick by distance.
  const scale = 205 / max;
  const vivid: Rgb = [rgb[0] * scale, rgb[1] * scale, rgb[2] * scale];
  let best = BASIC[1] as readonly [number, Rgb];
  for (const entry of BASIC.slice(1, 7)) {
    if (distance(entry[1], vivid) < distance(best[1], vivid)) best = entry;
  }
  return best[0];
}

export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

function colorCode(hex: string, level: ColorLevel, background: boolean): string {
  const rgb = hexToRgb(hex);
  if (level === 3) return `${background ? 48 : 38};2;${rgb.join(';')}`;
  if (level === 2) return `${background ? 48 : 38};5;${toAnsi256(rgb)}`;
  const code = toAnsi16(rgb);
  return String(background ? code + 10 : code);
}

/** `text` wrapped in SGR codes for `style` at `level` (unchanged at level 0). */
export function paint(text: string, style: Style, level: ColorLevel): string {
  if (level === 0 || text === '') return text;
  const codes: string[] = [];
  if (style.bold) codes.push('1');
  if (style.dim) codes.push('2');
  if (style.italic) codes.push('3');
  if (style.underline) codes.push('4');
  if (style.strike) codes.push('9');
  if (style.fg !== undefined) codes.push(colorCode(style.fg, level, false));
  // A background only where the chip stays readable: basic ANSI backgrounds are too loud.
  if (style.bg !== undefined && level >= 2) codes.push(colorCode(style.bg, level, true));
  if (codes.length === 0) return text;
  return `\u001b[${codes.join(';')}m${text}\u001b[0m`;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point.
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Display width: wide East Asian characters and emoji take two cells, combining marks none. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (/\p{Mn}|\p{Me}|‍|️/u.test(ch)) continue;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Cuts plain `text` to `width` cells, ending in `…` when shortened. */
export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

export function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/**
 * User content (titles, descriptions, names) without control characters, so a task can never
 * move the cursor, retitle the terminal or smuggle escape sequences into a listing. Bidi
 * overrides go too, so text cannot pretend to be something else. Tabs and newlines stay.
 */
export function clean(text: string): string {
  return text.replace(CONTROL_RE, '');
}
