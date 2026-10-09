import { UUIDV7_REGEX } from './ids.ts';

/**
 * Markdown-light for comment bodies (FR-COL-3, ADR 0028 §3): paragraphs and line breaks, bold,
 * italic, inline code, fenced code blocks, bulleted and numbered lists, links, bare URLs and
 * `@[Name](user:<id>)` mentions. The parser returns an AST of plain strings; the web renders it
 * to React elements, so no input ever becomes markup. Raw HTML stays text, and links keep only
 * `http:`, `https:` and `mailto:` targets (anything else stays text).
 *
 * A simplified CommonMark: emphasis uses the delimiter-run rules (so `snake_case` and `2*3*4`
 * stay text), lists are flat, and there are no headings, quotes, tables or images.
 */

export type CommentInline =
  | { type: 'text'; text: string }
  | { type: 'break' }
  | { type: 'strong'; children: CommentInline[] }
  | { type: 'em'; children: CommentInline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: CommentInline[] }
  | { type: 'mention'; userId: string; name: string };

export type CommentBlock =
  | { type: 'paragraph'; children: CommentInline[] }
  | { type: 'code_block'; text: string }
  | {
      type: 'list';
      ordered: boolean;
      /** The first number of an ordered list (1 for bullets). */
      start: number;
      items: CommentInline[][];
    };

/** Emphasis deeper than this stays text: bounds the renderer's recursion. */
export const COMMENT_NESTING_MAX = 8;

const BULLET_RE = /^ {0,3}[-*+][ \t]+(.*)$/;
const ORDERED_RE = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;
const CONTINUATION_RE = /^(?: {2,}|\t)\S/;

/** Parses a comment body into blocks. Never throws. */
export function parseCommentMarkdown(body: string): CommentBlock[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const blocks: CommentBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[][] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
    }
    paragraph = [];
  };
  const flushList = () => {
    if (list) {
      blocks.push({
        type: 'list',
        ordered: list.ordered,
        start: list.start,
        items: list.items.map((lines) => parseInline(lines.join('\n'))),
      });
    }
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const marker = fenceOpener(line);
    if (marker !== null) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      for (i += 1; i < lines.length; i++) {
        const next = lines[i] as string;
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(next);
        if (close && close[1]?.[0] === marker[0] && (close[1]?.length ?? 0) >= marker.length) break;
        code.push(next);
      }
      blocks.push({ type: 'code_block', text: code.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    const ordered = bullet ? null : ORDERED_RE.exec(line);
    // CommonMark: only a list starting at 1 may interrupt a paragraph ("in\n2024. it rained").
    const interrupts = bullet !== null || (ordered !== null && ordered[1] === '1');
    if ((bullet || ordered) && (paragraph.length === 0 || interrupts)) {
      flushParagraph();
      const isOrdered = ordered !== null;
      const text = ((bullet ?? ordered)?.[isOrdered ? 2 : 1] ?? '').trim();
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = {
          ordered: isOrdered,
          start: isOrdered ? Number(ordered?.[1]) : 1,
          items: [],
        };
      }
      list.items.push([text]);
      continue;
    }
    if (list && CONTINUATION_RE.test(line)) {
      list.items.at(-1)?.push(line.trim());
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

/**
 * The opening fence of a code block (up to 3 spaces, then 3+ backticks or tildes, and no
 * backtick after the run), or null. A linear scan: the regex this replaces backtracked
 * quadratically on a long tilde run followed by a backtick (110 ms per 20 KB comment).
 */
function fenceOpener(line: string): string | null {
  let start = 0;
  while (start < 3 && line[start] === ' ') start += 1;
  const char = line[start];
  if (char !== '`' && char !== '~') return null;
  let end = start;
  while (line[end] === char) end += 1;
  if (end - start < 3) return null;
  if (line.indexOf('`', end) !== -1) return null;
  return line.slice(start, end);
}

/**
 * Whether a code span's content loses one space at each end (CommonMark: it starts and ends
 * with a space and is not only spaces). Linear; `/^ .*[^ ].* $/s` was quadratic.
 */
function stripsSpaces(code: string): boolean {
  if (code.length < 3 || code[0] !== ' ' || code[code.length - 1] !== ' ') return false;
  for (let k = 1; k < code.length - 1; k++) if (code[k] !== ' ') return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------------------------

/** An emphasis delimiter run before matching. */
interface Delim {
  type: 'delim';
  char: '*' | '_';
  count: number;
  /** The run's length before matching (CommonMark's "rule of 3"). */
  length: number;
  canOpen: boolean;
  canClose: boolean;
  /**
   * Pairing with this opener nests too deep. Later closers only see more content in between,
   * so they would fail too: remembered, so the depth is not recounted for each (linear).
   */
  tooDeep?: boolean;
}

type Atom = CommentInline | Delim;

const ESCAPABLE = /[!-/:-@[-`{-~]/;
const MENTION_RE = /^@\[([^\]\n]{1,100})\]\(user:([0-9a-f-]{36})\)/;
const LINK_RE = /^\[([^[\]\n]{1,500})\]\(([^\s()<>]{1,2000})\)/;
const URL_RE = /^https?:\/\/[^\s<>"]+/i;
const SAFE_HREF_RE = /^(?:https?:\/\/[^\s]+|mailto:[^\s]+)$/i;

/** Whether a link target may become an `href` (http, https and mailto only). */
export function isSafeHref(href: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we reject.
  return SAFE_HREF_RE.test(href) && !/[\u0000-\u001f\u007f]/.test(href);
}

const isSpace = (c: string | undefined) => c === undefined || /\s/u.test(c);
const isPunct = (c: string | undefined) => c !== undefined && /[\p{P}\p{S}]/u.test(c);

/** Inline content of one paragraph or list item. */
export function parseInline(text: string, links = true): CommentInline[] {
  const atoms: Atom[] = [];
  let buffer = '';
  const pushText = (s: string) => {
    buffer += s;
  };
  const flush = () => {
    if (buffer !== '') atoms.push({ type: 'text', text: buffer });
    buffer = '';
  };
  const push = (atom: Atom) => {
    flush();
    atoms.push(atom);
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const rest = text.slice(i);
    if (c === '\\' && ESCAPABLE.test(text[i + 1] ?? '')) {
      pushText(text[i + 1] as string);
      i += 2;
      continue;
    }
    if (c === '\n') {
      push({ type: 'break' });
      i += 1;
      continue;
    }
    if (c === '`') {
      const run = /^`+/.exec(rest)?.[0] as string;
      const close = findBacktickRun(text, i + run.length, run.length);
      if (close < 0) {
        pushText(run);
        i += run.length;
        continue;
      }
      let code = text.slice(i + run.length, close).replace(/\n/g, ' ');
      if (stripsSpaces(code)) code = code.slice(1, -1);
      push({ type: 'code', text: code });
      i = close + run.length;
      continue;
    }
    if (c === '@') {
      const m = MENTION_RE.exec(rest);
      if (m && UUIDV7_REGEX.test(m[2] as string)) {
        push({ type: 'mention', name: m[1] as string, userId: m[2] as string });
        i += m[0].length;
        continue;
      }
    }
    if (c === '[' && links) {
      const m = LINK_RE.exec(rest);
      if (m) {
        const href = m[2] as string;
        if (isSafeHref(href)) {
          push({ type: 'link', href, children: parseInline(m[1] as string, false) });
        } else {
          pushText(m[0]);
        }
        i += m[0].length;
        continue;
      }
    }
    if ((c === 'h' || c === 'H') && links && !/[\p{L}\p{N}]/u.test(text[i - 1] ?? '')) {
      const m = URL_RE.exec(rest);
      if (m) {
        const url = trimUrl(m[0]);
        if (/^https?:\/\/[^/?#]/i.test(url)) {
          push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
          i += url.length;
          continue;
        }
      }
    }
    if (c === '*' || c === '_') {
      const run = (c === '*' ? /^\*+/ : /^_+/).exec(rest)?.[0] as string;
      const before = text[i - 1];
      const after = text[i + run.length];
      const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
      const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
      const canOpen = c === '*' ? left : left && (!right || isPunct(before));
      const canClose = c === '*' ? right : right && (!left || isPunct(after));
      push({ type: 'delim', char: c, count: run.length, length: run.length, canOpen, canClose });
      i += run.length;
      continue;
    }
    pushText(c);
    i += 1;
  }
  flush();
  return finish(matchEmphasis(atoms));
}

/** The index of the next run of exactly `length` backticks at or after `from`, or -1. */
function findBacktickRun(text: string, from: number, length: number): number {
  const re = /`+/g;
  re.lastIndex = from;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === length) return m.index;
  }
  return -1;
}

/**
 * Trailing punctuation is not part of a bare URL; a closing paren only when it is unbalanced.
 * Linear: the parens are counted once and the count follows the trimming (a URL followed by
 * thousands of `)` once took a second per comment).
 */
function trimUrl(url: string): string {
  let open = 0;
  let close = 0;
  for (let k = 0; k < url.length; k++) {
    if (url[k] === '(') open += 1;
    else if (url[k] === ')') close += 1;
  }
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last !== undefined && TRAILING_PUNCT.has(last)) {
      end -= 1;
      continue;
    }
    if (last === ')' && open < close) {
      end -= 1;
      close -= 1;
      continue;
    }
    return url.slice(0, end);
  }
}

const TRAILING_PUNCT: ReadonlySet<string> = new Set([...".,;:!?'*_"]);

const depthOf = (atoms: readonly Atom[]): number => {
  let max = 0;
  for (const atom of atoms) {
    if (atom.type === 'strong' || atom.type === 'em' || atom.type === 'link') {
      max = Math.max(max, 1 + depthOf(atom.children));
    }
  }
  return max;
};

/** How far down the opener stack a closer looks past openers the rule of 3 rules out. */
const OPENER_LOOKBACK = 32;

/**
 * CommonMark's "process emphasis", simplified: each closer pairs with the nearest opener of
 * the same character (skipping ones the "rule of 3" forbids, so `*a**b*` is one `em`); two or
 * more on both sides make `strong`, otherwise `em`. Openers between a matched pair stay text.
 * Nesting beyond `COMMENT_NESTING_MAX` stays text.
 */
function matchEmphasis(input: Atom[]): Atom[] {
  const atoms = [...input];
  const openers: Record<'*' | '_', number[]> = { '*': [], _: [] };
  for (let i = 0; i < atoms.length; i++) {
    const closer = atoms[i] as Atom;
    if (closer.type !== 'delim') continue;
    while (closer.canClose && closer.count > 0) {
      const stack = openers[closer.char];
      let at = stack.length - 1;
      while (at >= 0 && stack.length - at <= OPENER_LOOKBACK) {
        if (!ruleOfThree(atoms[stack[at] as number] as Delim, closer)) break;
        at -= 1;
      }
      if (at < 0 || stack.length - at > OPENER_LOOKBACK) break;
      const j = stack[at] as number;
      const opener = atoms[j] as Delim;
      if (opener.tooDeep) break;
      const children = atoms.slice(j + 1, i);
      if (depthOf(children) >= COMMENT_NESTING_MAX) {
        opener.tooDeep = true;
        break;
      }
      const use = opener.count >= 2 && closer.count >= 2 ? 2 : 1;
      atoms.splice(j + 1, i - j - 1, {
        type: use === 2 ? 'strong' : 'em',
        children: finish(children),
      });
      i = j + 2;
      // Openers inside the pair can no longer match; a used-up opener leaves the stack. The
      // stacks are sorted, so popping from the top is enough (linear overall).
      for (const key of ['*', '_'] as const) {
        const keyed = openers[key];
        while (keyed.length > 0 && (keyed.at(-1) as number) > j) keyed.pop();
        if (keyed.at(-1) === j && opener.count <= use) keyed.pop();
      }
      opener.count -= use;
      closer.count -= use;
    }
    if (closer.count > 0 && closer.canOpen) openers[closer.char].push(i);
  }
  return atoms;
}

/** CommonMark: a run that can both open and close pairs only if the lengths allow it. */
function ruleOfThree(opener: Delim, closer: Delim): boolean {
  if (!opener.canClose && !closer.canOpen) return false;
  const sum = opener.length + closer.length;
  return sum % 3 === 0 && (opener.length % 3 !== 0 || closer.length % 3 !== 0);
}

/** Leftover delimiters become text; adjacent text merges. */
function finish(atoms: readonly Atom[]): CommentInline[] {
  const out: CommentInline[] = [];
  for (const atom of atoms) {
    const node: CommentInline | null =
      atom.type === 'delim'
        ? atom.count > 0
          ? { type: 'text', text: atom.char.repeat(atom.count) }
          : null
        : atom;
    if (!node) continue;
    const last = out.at(-1);
    if (node.type === 'text' && last?.type === 'text') {
      out[out.length - 1] = { type: 'text', text: last.text + node.text };
    } else {
      out.push(node);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Back to text
// ---------------------------------------------------------------------------------------------

/** Plain text of a comment (previews, notifications, accessible names): mentions as `@Name`. */
export function commentToPlainText(blocks: readonly CommentBlock[]): string {
  return blocks.map(blockText).join('\n\n');
}

function blockText(block: CommentBlock): string {
  if (block.type === 'paragraph') return inlineText(block.children);
  if (block.type === 'code_block') return block.text;
  return block.items.map((item) => inlineText(item)).join('\n');
}

function inlineText(nodes: readonly CommentInline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
        case 'code':
          return node.text;
        case 'break':
          return '\n';
        case 'mention':
          return `@${node.name}`;
        default:
          return inlineText(node.children);
      }
    })
    .join('');
}

/**
 * Serialises an AST back to Markdown-light. Parsing the result gives the same AST
 * (`parse(toMarkdown(parse(x)))` equals `parse(x)`), which the tests check over a corpus.
 */
export function commentToMarkdown(blocks: readonly CommentBlock[]): string {
  return blocks.map(blockMarkdown).join('\n\n');
}

function blockMarkdown(block: CommentBlock): string {
  if (block.type === 'paragraph') return escapeLineStarts(inlineMarkdown(block.children));
  if (block.type === 'code_block') {
    const longest = Math.max(2, ...(block.text.match(/`+/g) ?? []).map((r) => r.length));
    const fence = '`'.repeat(longest + 1);
    return `${fence}\n${block.text}\n${fence}`;
  }
  return block.items
    .map((item, i) => {
      const marker = block.ordered ? `${block.start + i}.` : '-';
      return `${marker} ${escapeLineStarts(inlineMarkdown(item)).replace(/\n/g, '\n  ')}`;
    })
    .join('\n');
}

/** Inline specials of the parser; `\\` + any of them reads back as the character. */
const escapeText = (text: string) => text.replace(/[\\`*_[\]@]/g, '\\$&');

/** Text at the start of a line that the block parser would read as a list marker or fence. */
const escapeLineStarts = (text: string) =>
  text
    .replace(
      /^( {0,3})([-+]|\d{1,9}(?=[.)]))(?=[.)]?(?:[ \t]|$))/gm,
      (_m, sp: string, marker: string) =>
        /\d/.test(marker) ? `${sp}${marker}\\` : `${sp}\\${marker}`,
    )
    .replace(/^( {0,3})(~{3,})/gm, '$1\\$2');

function inlineMarkdown(nodes: readonly CommentInline[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += escapeText(node.text);
        break;
      case 'break':
        out += '\n';
        break;
      case 'code': {
        const longest = Math.max(0, ...(node.text.match(/`+/g) ?? []).map((r) => r.length));
        const ticks = '`'.repeat(longest + 1);
        const pad =
          node.text.startsWith('`') || node.text.endsWith('`') || stripsSpaces(node.text)
            ? ' '
            : '';
        out += `${ticks}${pad}${node.text}${pad}${ticks}`;
        break;
      }
      case 'mention':
        out += `@[${node.name}](user:${node.userId})`;
        break;
      case 'strong':
        out += `**${inlineMarkdown(node.children)}**`;
        break;
      case 'em':
        out += `*${inlineMarkdown(node.children)}*`;
        break;
      case 'link': {
        const [only] = node.children;
        const bare =
          node.children.length === 1 &&
          only?.type === 'text' &&
          only.text === node.href &&
          /^https?:\/\/[^/?#]/i.test(node.href) &&
          trimUrl(node.href) === node.href &&
          !/[\p{L}\p{N}]$/u.test(out);
        out += bare ? node.href : `[${inlineMarkdown(node.children)}](${node.href})`;
        break;
      }
    }
  }
  return out;
}
