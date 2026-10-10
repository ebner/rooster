import { type ColorLevel, clean, paint } from './color.ts';
import { styles } from './theme.ts';

/**
 * Replaces Markdown images (`![alt](url title)`, `image`) or links (`[label](url title)`) left
 * to right. The next `]` and `)` are found with cursors that only move forward, so hostile text
 * such as `[[[[…](aaaa…` costs linear time (ADR 0040 §7), where regexes backtracked cubically.
 */
function replaceLinks(
  text: string,
  image: boolean,
  render: (label: string, url: string) => string,
): string {
  const end = text.length;
  const find = (ch: string, at: number) => {
    const index = text.indexOf(ch, at);
    return index === -1 ? end : index;
  };
  const open = image ? '![' : '[';
  let out = '';
  let copied = 0;
  // The first `]` after the current `[`, and the first `)` after that `](`; `end` = none.
  let close = -1;
  let paren = -1;
  for (let i = text.indexOf(open); i !== -1; i = text.indexOf(open, i + 1)) {
    const labelStart = i + open.length;
    if (close < labelStart) close = find(']', labelStart);
    if (close === end) break;
    if (text[close + 1] !== '(') continue;
    const urlStart = close + 2;
    if (paren < urlStart) paren = find(')', urlStart);
    if (paren === end) break;
    if (paren === urlStart || /\s/.test(text[urlStart] ?? '')) continue;
    const label = text.slice(labelStart, close);
    if (!image && label === '') continue;
    let urlEnd = urlStart;
    while (urlEnd < paren && !/\s/.test(text[urlEnd] ?? '')) urlEnd += 1;
    out += text.slice(copied, i) + render(label, text.slice(urlStart, urlEnd));
    copied = paren + 1;
    i = paren;
  }
  return out + text.slice(copied);
}

/** Inline Markdown: code, bold, italics, strikethrough and links (`text <url>`). */
function inline(text: string, level: ColorLevel): string {
  const codes: string[] = [];
  // Code spans first, so nothing inside them is formatted.
  let out = text.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(paint(code, styles.secondary, level));
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = replaceLinks(out, true, (alt, url) => paint(`[${alt || url}]`, styles.muted, level));
  out = replaceLinks(out, false, (label, url) =>
    label === url
      ? paint(url, styles.link, level)
      : `${label} ${paint(`<${url}>`, styles.link, level)}`,
  )
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a?: string, b?: string) =>
      paint(a ?? b ?? '', { bold: true }, level),
    )
    .replace(
      /(^|[^*\w])\*([^*\s][^*]*)\*/g,
      (_, pre: string, body: string) => `${pre}${paint(body, { italic: true }, level)}`,
    )
    .replace(/~~([^~]+)~~/g, (_, body: string) => paint(body, { strike: true }, level));
  // biome-ignore lint/suspicious/noControlCharactersInRegex: placeholders for code spans.
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)] ?? '');
}

/**
 * Renders a task description (CommonMark subset, 04 §4.11) for the terminal: headings, lists,
 * task lists, quotes, code blocks and rules. Raw HTML stays as text; nothing is executed.
 */
export function renderMarkdown(source: string, level: ColorLevel): string[] {
  const lines = clean(source.replace(/\r\n?/g, '\n')).split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch) {
      fence = fence === null ? (fenceMatch[1] ?? '```') : null;
      continue;
    }
    if (fence !== null) {
      out.push(`    ${paint(line, styles.secondary, level)}`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(paint(inline(heading[2] ?? '', 0), styles.heading, level));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(paint('─'.repeat(24), styles.muted, level));
      continue;
    }
    const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      const done = task[2] !== ' ';
      const box = done ? paint('☑', styles.check, level) : '☐';
      out.push(`${task[1]}${box} ${inline(task[3] ?? '', level)}`);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}• ${inline(bullet[2] ?? '', level)}`);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(`${paint('│', styles.muted, level)} ${inline(quote[1] ?? '', level)}`);
      continue;
    }
    out.push(inline(line, level));
  }
  while (out.length > 0 && out[out.length - 1]?.trim() === '') out.pop();
  return out;
}
