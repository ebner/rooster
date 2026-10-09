import { type ColorLevel, displayWidth, paint, type Style } from '../output/color.ts';

/**
 * Terminal text for the TUI: a line is a list of styled segments of plain (already `clean`ed)
 * text, cut to a cell width before it is painted, so truncation never splits an escape
 * sequence and user content never carries one.
 */
export interface Seg {
  text: string;
  style?: Style | undefined;
}

export const seg = (text: string, style?: Style): Seg => ({ text, style });

export function segsWidth(segs: readonly Seg[]): number {
  let width = 0;
  for (const s of segs) width += displayWidth(s.text);
  return width;
}

/** Cuts plain `text` to at most `width` cells (no ellipsis). */
function cut(text: string, width: number): string {
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out;
}

/**
 * The segments cut to `width` cells (ending in `…` when shortened) and padded with spaces to
 * exactly `width`, then painted at `level`.
 */
export function fit(segs: readonly Seg[], width: number, level: ColorLevel): string {
  if (width <= 0) return '';
  const total = segsWidth(segs);
  let out = '';
  if (total <= width) {
    for (const s of segs) out += s.style ? paint(s.text, s.style, level) : s.text;
    return out + ' '.repeat(width - total);
  }
  let room = width - 1;
  let lastStyle: Style | undefined;
  for (const s of segs) {
    if (room <= 0) break;
    const part = cut(s.text, room);
    room -= displayWidth(part);
    out += s.style ? paint(part, s.style, level) : part;
    lastStyle = s.style;
    if (part.length < s.text.length) break;
  }
  const ellipsis = lastStyle ? paint('…', lastStyle, level) : '…';
  const used = width - 1 - room;
  return out + ellipsis + ' '.repeat(Math.max(0, width - used - 1));
}

/** Plain `text` cut to `width` cells with `…`, unpadded. */
export function ellipsize(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  return `${cut(text, width - 1)}…`;
}

/** Pads an already painted string to `width` cells (it must not be wider). */
export function padAnsi(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: tokenising SGR escapes is the point.
const SGR_TOKEN = /(\u001b\[[0-9;]*m)/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR escapes is the point.
const SGR_ALL = /\u001b\[[0-9;]*m/g;
const visible = (text: string) => text.replace(SGR_ALL, '');

/**
 * Word-wraps a painted line (ANSI SGR only, as `paint` writes it) to `width` cells. A style
 * open across a break is closed at the end of the line and reopened on the next, so every
 * returned line is self-contained. Words longer than a line are split.
 */
export function wrapAnsi(text: string, width: number): string[] {
  if (width <= 0) return [];
  if (displayWidth(text) <= width) return [text];
  const indent = /^ */.exec(visible(text))?.[0] ?? '';
  const hang = indent.length < width / 2 ? indent : '';
  const lines: string[] = [];
  let line = '';
  let used = 0;
  let active = '';
  // Text since the last space on this line, so a word can move to the next line whole.
  let word = '';
  let wordWidth = 0;
  let wordStartActive = '';
  const breakLine = () => {
    lines.push(active === '' ? line : `${line}\u001b[0m`);
    line = hang + active;
    used = hang.length;
  };
  const flushWord = () => {
    line += word;
    used += wordWidth;
    word = '';
    wordWidth = 0;
  };
  for (const token of text.split(SGR_TOKEN)) {
    if (token === '') continue;
    if (SGR_TOKEN.test(token)) {
      active = token === '\u001b[0m' ? '' : token;
      word += token;
      continue;
    }
    for (const ch of token) {
      const w = displayWidth(ch);
      if (ch === ' ') {
        flushWord();
        if (used + 1 > width) breakLine();
        else if (!(used === hang.length && lines.length > 0)) {
          line += ch;
          used += 1;
        }
        wordStartActive = active;
        continue;
      }
      if (used + wordWidth + w > width) {
        if (wordWidth > 0 && used > hang.length) {
          // Move the word to a fresh line.
          const pending = word;
          const pendingWidth = wordWidth;
          word = '';
          wordWidth = 0;
          line = line.replace(/ +$/, '');
          lines.push(wordStartActive === '' ? line : `${line}\u001b[0m`);
          line = hang + wordStartActive + pending;
          used = hang.length + pendingWidth;
        } else {
          flushWord();
          breakLine();
        }
      }
      word += ch;
      wordWidth += w;
    }
  }
  flushWord();
  if (visible(line).trim() !== '' || lines.length === 0) lines.push(line);
  return lines;
}
