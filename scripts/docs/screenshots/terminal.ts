import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * The TUI's screenshot: `apps/cli/scripts/tui-frame.ts` renders one frame of the real TUI with
 * its colours, and `terminalHtml` draws it as a light terminal window, the way the TUI's Coop
 * colours are meant to be seen.
 */

const root = resolve(import.meta.dirname, '../../..');

export function tuiFrame(
  server: string,
  token: string,
  options: {
    columns: number;
    rows: number;
    org?: string;
    wait: string[];
    keys?: string[];
    timezone: string;
  },
): string {
  const args = ['--columns', String(options.columns), '--rows', String(options.rows)];
  if (options.org) args.push('--org', options.org);
  for (const text of options.wait) args.push('--wait', text);
  args.push('--keys', JSON.stringify(options.keys ?? []));
  const out = execFileSync(
    'pnpm',
    ['--silent', '--filter', '@rooster/cli', 'exec', 'tsx', 'scripts/tui-frame.ts', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ROOSTER_TUI_SERVER: server,
        ROOSTER_TUI_TOKEN: token,
        TZ: options.timezone,
      },
      timeout: 60_000,
    },
  );
  const line = out.trim().split('\n').at(-1) ?? '';
  return (JSON.parse(line) as { frame: string }).frame;
}

interface Pen {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
}

const blank = (): Pen => ({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false,
});

/** xterm's 16 colours as a light theme shows them, then the 256-colour cube and greys. */
const basic = [
  '#16191E',
  '#B42318',
  '#067647',
  '#B54708',
  '#175CD3',
  '#6941C6',
  '#0E7090',
  '#D0D5DD',
  '#475467',
  '#D92D20',
  '#079455',
  '#DC6803',
  '#2E90FA',
  '#7F56D9',
  '#0BA5EC',
  '#FFFFFF',
];
function color256(n: number): string {
  if (n < 16) return basic[n] as string;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const step = (c: number) => (c === 0 ? 0 : 55 + c * 40);
  return `rgb(${step(Math.floor(i / 36))},${step(Math.floor(i / 6) % 6)},${step(i % 6)})`;
}

function applySgr(pen: Pen, params: number[]): Pen {
  const next = { ...pen };
  for (let i = 0; i < params.length; i++) {
    const p = params[i] ?? 0;
    if (p === 0) Object.assign(next, blank());
    else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 7) next.inverse = true;
    else if (p === 9) next.strike = true;
    else if (p === 22) next.bold = next.dim = false;
    else if (p === 23) next.italic = false;
    else if (p === 24) next.underline = false;
    else if (p === 27) next.inverse = false;
    else if (p === 29) next.strike = false;
    else if (p >= 30 && p <= 37) next.fg = basic[p - 30] as string;
    else if (p >= 90 && p <= 97) next.fg = basic[p - 90 + 8] as string;
    else if (p >= 40 && p <= 47) next.bg = basic[p - 40] as string;
    else if (p >= 100 && p <= 107) next.bg = basic[p - 100 + 8] as string;
    else if (p === 39) next.fg = null;
    else if (p === 49) next.bg = null;
    else if (p === 38 || p === 48) {
      const mode = params[i + 1];
      let value: string | null = null;
      if (mode === 2) {
        value = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`;
        i += 4;
      } else if (mode === 5) {
        value = color256(params[i + 2] ?? 0);
        i += 2;
      }
      if (p === 38) next.fg = value;
      else next.bg = value;
    }
  }
  return next;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ink = '#16191E';
const paper = '#FFFFFF';

function span(text: string, pen: Pen): string {
  if (!text) return '';
  if (text.includes('\n')) {
    return text
      .split('\n')
      .map((part) => span(part, pen))
      .join('\n');
  }
  let fg = pen.fg ?? ink;
  let bg = pen.bg;
  if (pen.inverse) [fg, bg] = [bg ?? paper, fg];
  const css = [`color:${fg}`];
  if (bg) css.push(`background:${bg}`);
  if (pen.bold) css.push('font-weight:700');
  if (pen.dim) css.push('opacity:.6');
  if (pen.italic) css.push('font-style:italic');
  const lines = [pen.underline && 'underline', pen.strike && 'line-through'].filter(Boolean);
  if (lines.length) css.push(`text-decoration:${lines.join(' ')}`);
  return `<span style="${css.join(';')}">${escapeHtml(text)}</span>`;
}

/** One frame's ANSI text as HTML spans (SGR only: Ink writes nothing else into a frame). */
export function ansiToHtml(frame: string): string {
  let pen = blank();
  let html = '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the input.
  const pattern = /\u001b\[([0-9;]*)m/g;
  let at = 0;
  for (const match of frame.matchAll(pattern)) {
    html += span(frame.slice(at, match.index), pen);
    const params = (match[1] ?? '').split(';').filter(Boolean).map(Number);
    pen = applySgr(pen, params.length ? params : [0]);
    at = match.index + match[0].length;
  }
  html += span(frame.slice(at), pen);
  // One fixed-height row per line, like a terminal's cell grid: a fallback glyph (an emoji)
  // can't make its line taller. Spans never cross a newline once split here.
  return html
    .split('\n')
    .map((line) => `<div class="row">${line || ' '}</div>`)
    .join('');
}

/** A light terminal window around the frame. */
export function terminalHtml(frame: string, title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #F2F4F7; }
  .window { display: inline-block; margin: 24px; border-radius: 10px; overflow: hidden;
    background: ${paper}; box-shadow: 0 1px 2px rgba(16,24,40,.06), 0 12px 32px rgba(16,24,40,.12);
    border: 1px solid #D0D5DD; }
  .bar { height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 12px;
    background: #F9FAFB; border-bottom: 1px solid #EAECF0; font: 500 12px system-ui, sans-serif;
    color: #475467; }
  .dot { width: 11px; height: 11px; border-radius: 50%; background: #D0D5DD; }
  .title { flex: 1; text-align: center; margin-right: 50px; }
  pre { margin: 0; padding: 12px 14px 14px; font: 13px 'DejaVu Sans Mono', 'Menlo', monospace;
    color: ${ink}; white-space: pre; }
  .row { height: 15px; line-height: 15px; overflow: visible; }
</style></head><body><div class="window" id="terminal"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="title">${escapeHtml(title)}</span></div><pre>${ansiToHtml(frame)}</pre></div></body></html>`;
}
