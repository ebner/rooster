import { MarkdownManager } from '@tiptap/markdown';
import type { JSONContent } from '@tiptap/react';
import { schemaExtensions } from './extensions';
import { autolinkText, type LinkAttrs } from './link';

/*
 * Markdown ⇄ editor document for task descriptions (FR-DET-3, 10 §3.5).
 *
 * Parsing uses marked through @tiptap/markdown with two changes:
 * - Raw HTML is never interpreted: marked's `html` and `tag` tokenizers are switched
 *   off, so `<b>x</b>` stays literal text.
 * - Text is escaped minimally (`escapeMarkdownText`) instead of backslash-escaping
 *   every `*`, `_`, `[` … and HTML-encoding `&`, `<`, `>`, which the stock
 *   serializer does. Descriptions written by hand or by the CLI then survive a
 *   round trip through the editor unchanged. The normalisations that remain are
 *   listed in `markdown.corpus.ts`.
 */

type EncodeText = (text: string, node: JSONContent, parent?: JSONContent) => string;

const asciiPunctuation = /[!-/:-@[-`{-~]/;
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Context outside a text run: `undefined` = a line edge, `'*'` = unknown punctuation. */
export interface TextContext {
  /** The run starts a line (the start of a block, or after a hard break). */
  atLineStart: boolean;
  /** The character before the run, or undefined at a line start. */
  before: string | undefined;
  /** The character after the run, or undefined at a line end. */
  after: string | undefined;
}

/** Line-start syntax that would turn plain text into a block (heading, list, quote, …). */
function escapeLineStart(line: string, isContinuation: boolean): string {
  if (/^#{1,6}(\s|$)/.test(line)) return `\\${line}`;
  if (/^([-*_])(\s*\1){2,}\s*$/.test(line)) return `\\${line}`;
  if (/^[-+*](\s|$)/.test(line)) return `\\${line}`;
  if (/^>/.test(line)) return `\\${line}`;
  if (/^\[[ xX]?\](\s|$)/.test(line)) return `\\${line}`;
  if (isContinuation && /^(=+|-+)\s*$/.test(line)) return `\\${line}`;
  return line.replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2');
}

/**
 * Backslash-escapes only what would otherwise be read as Markdown syntax:
 * emphasis delimiters that could open or close (not `2 * 3` or `snake_case`),
 * backticks, `[` that would start a link, entity-like `&…;`, autolink-like `<…>`,
 * a backslash before punctuation, and block syntax at the start of a line.
 */
export function escapeMarkdownText(text: string, ctx: TextContext): string {
  const lines = text.split('\n');
  return lines
    .map((line, lineIndex) => {
      const lineStart = lineIndex > 0 || ctx.atLineStart;
      const before = lineIndex > 0 ? undefined : ctx.before;
      const after = lineIndex < lines.length - 1 ? undefined : ctx.after;
      let out = '';
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i] as string;
        const prev = i > 0 ? line[i - 1] : before;
        const next = i < line.length - 1 ? line[i + 1] : after;
        switch (ch) {
          case '\\':
            out += next === undefined || asciiPunctuation.test(next) ? '\\\\' : ch;
            break;
          case '`':
            out += '\\`';
            break;
          case '*':
          case '~':
            out += isSpace(prev) && isSpace(next) ? ch : `\\${ch}`;
            break;
          case '_':
            out +=
              (isSpace(prev) && isSpace(next)) || (isWordChar(prev) && isWordChar(next))
                ? ch
                : '\\_';
            break;
          case '[': {
            // Only a `]` followed by `(`, `[` or `:` makes a link or reference.
            const close = line.indexOf(']', i + 1);
            const follower = close === -1 ? undefined : (line[close + 1] ?? after);
            out += follower !== undefined && '([:*'.includes(follower) ? '\\[' : ch;
            break;
          }
          case '&':
            out += /^&(#\d{1,7}|#[xX][\da-fA-F]{1,6}|[a-zA-Z][a-zA-Z\d]{1,31});/.test(line.slice(i))
              ? '\\&'
              : ch;
            break;
          case '<':
            out += /^<([a-zA-Z][a-zA-Z\d+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/.test(
              line.slice(i),
            )
              ? '\\<'
              : ch;
            break;
          default:
            out += ch;
        }
      }
      // Trailing spaces at a line end would read as a hard break, or be dropped.
      if (lineIndex < lines.length - 1 || after === undefined) out = out.trimEnd();
      return lineStart ? escapeLineStart(out, lineIndex > 0 || !ctx.atLineStart) : out;
    })
    .join('\n');
}

const codeTypes = new Set(['codeBlock', 'code']);

/**
 * What borders a text run on one side: nothing at a line edge, otherwise a stand-in
 * for punctuation, since adjacent runs differ in marks and so meet at delimiters.
 */
function neighbour(node: JSONContent | undefined): string | undefined {
  return !node || node.type === 'hardBreak' ? undefined : '*';
}

/** True when the node is (part of) a link that renders as a bare or `<…>` autolink. */
function inAutolink(node: JSONContent): boolean {
  return (node.marks ?? []).some((mark) => {
    if (mark.type !== 'link') return false;
    const attrs = (mark.attrs ?? {}) as LinkAttrs;
    const bare = attrs.href && !attrs.title ? autolinkText(attrs.href) : null;
    return bare?.includes(node.text ?? '') ?? false;
  });
}

const encodeText: EncodeText = (text, node, parent) => {
  const marks = node.marks ?? [];
  if ((parent?.type && codeTypes.has(parent.type)) || marks.some((m) => codeTypes.has(m.type))) {
    return text;
  }
  if (inAutolink(node)) return text;
  const siblings = parent?.content ?? [];
  const index = siblings.indexOf(node);
  const prevNode = index > 0 ? siblings[index - 1] : undefined;
  const nextNode = index >= 0 ? siblings[index + 1] : undefined;
  return escapeMarkdownText(text, {
    atLineStart: index <= 0 || prevNode?.type === 'hardBreak',
    before: neighbour(prevNode),
    after: neighbour(nextNode),
  });
};

let shared: MarkdownManager | null = null;

/**
 * One converter for the whole app. @tiptap/markdown registers its tokenizers on the
 * global `marked` instance per manager, so creating one per editor would pile them up.
 */
export function markdownManager(): MarkdownManager {
  if (shared) return shared;
  const manager = new MarkdownManager({ extensions: schemaExtensions('markdown') });
  manager.instance.use({ tokenizer: { html: () => undefined, tag: () => undefined } });
  // Private hook of @tiptap/markdown 3.31 (pinned); the corpus test guards it.
  (manager as unknown as { encodeTextForMarkdown: EncodeText }).encodeTextForMarkdown = encodeText;
  shared = manager;
  return manager;
}

/**
 * Blockquotes and lists nested deeper than this on one line read as text from there on. marked
 * re-lexes every level, so `> > > …` thousands deep (any member can store it: the schema only
 * caps the length) would exhaust the stack or memory and break the pane for everyone.
 */
export const maxNesting = 20;

const isBlank = (ch: string | undefined) => ch === ' ' || ch === '\t';
const isDigit = (ch: string | undefined) => ch !== undefined && ch >= '0' && ch <= '9';

/**
 * Where a line's container marker beyond `maxNesting` starts (the offset to escape), or -1.
 * A linear scan of the line-start markers: `>`, `-`/`*`/`+` and `1.`/`1)` before a blank.
 */
function excessMarker(line: string): number {
  let i = 0;
  let depth = 0;
  while (i < line.length) {
    let j = i;
    while (isBlank(line[j])) j += 1;
    let k = j;
    let escapeAt = j;
    if (line[k] === '>') k += 1;
    else if ((line[k] === '-' || line[k] === '*' || line[k] === '+') && isBlank(line[k + 1])) {
      k += 1;
    } else {
      while (isDigit(line[k]) && k - j < 9) k += 1;
      if (k === j || (line[k] !== '.' && line[k] !== ')') || !isBlank(line[k + 1])) return -1;
      escapeAt = k;
      k += 1;
    }
    depth += 1;
    if (depth > maxNesting) return escapeAt;
    i = k;
  }
  return -1;
}

/** Leading indentation is capped at this many columns (lists nest by indentation too). */
const maxIndentColumns = maxNesting * 4;
const fence = /^[ \t]*(?:`{3,}|~{3,})/;

/** The line with its leading blanks capped at `maxIndentColumns` (a tab counts 4). */
function capIndent(line: string): string {
  let columns = 0;
  let i = 0;
  while (isBlank(line[i])) {
    columns += line[i] === '\t' ? 4 - (columns % 4) : 1;
    i += 1;
  }
  return columns > maxIndentColumns ? ' '.repeat(maxIndentColumns) + line.slice(i) : line;
}

/**
 * Bounds how deep one line can nest: indentation past `maxIndentColumns` is capped, and the
 * first container marker past `maxNesting` is escaped, so the rest reads as text. Lines inside
 * fenced code keep their indentation.
 */
export function boundNesting(source: string): string {
  let inFence = false;
  return source
    .split('\n')
    .map((raw) => {
      if (fence.test(raw)) inFence = !inFence;
      if (inFence) return raw;
      const line = capIndent(raw);
      const at = excessMarker(line);
      return at < 0 ? line : `${line.slice(0, at)}\\${line.slice(at)}`;
    })
    .join('\n');
}

/** Parses a description into an editor document (always at least one paragraph). */
export function fromMarkdown(markdown: string): JSONContent {
  // Leading and trailing blank lines would become empty paragraphs (N8 in the corpus).
  const source = boundNesting(markdown.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, ''));
  const doc = markdownManager().parse(source);
  return doc.content?.length ? doc : { type: 'doc', content: [{ type: 'paragraph' }] };
}

/** Serialises an editor document to the stored Markdown ('' for an empty document). */
export function toMarkdown(doc: JSONContent): string {
  return markdownManager().serialize(doc).replace(/\s+$/, '');
}
