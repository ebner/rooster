import { Editor, type JSONContent } from '@tiptap/react';
import { describe, expect, test } from 'vitest';
import { editorExtensions } from './extensions';
import { isAllowedLinkHref } from './link';
import { boundNesting, fromMarkdown, maxNesting, toMarkdown } from './markdown';
import { markdownCorpus } from './markdown.corpus';

const noKeys = {
  onEscape: () => false,
  onModEnter: () => false,
  onLinkShortcut: () => false,
  onFocusToolbar: () => false,
};

/** md → the real editor schema (as the description editor loads it) → md. */
function roundTrip(markdown: string): string {
  const editor = new Editor({
    extensions: editorExtensions({ placeholder: '', ...noKeys }),
    content: fromMarkdown(markdown),
  });
  const out = toMarkdown(editor.getJSON());
  editor.destroy();
  return out;
}

describe('Markdown round-trip corpus (10 §3.5)', () => {
  test('has 40 samples', () => {
    expect(markdownCorpus).toHaveLength(40);
  });

  test.each(markdownCorpus.map((s) => [s.name, s] as const))('%s', (_name, sample) => {
    const canonical = sample.expected ?? sample.md;
    expect(roundTrip(sample.md)).toBe(canonical);
    // The canonical form is a fixed point.
    expect(roundTrip(canonical)).toBe(canonical);
  });
});

/** Every link mark's href in a parsed document. */
function hrefsOf(doc: JSONContent): string[] {
  const out: string[] = [];
  const walk = (node: JSONContent) => {
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link') out.push(String(mark.attrs?.href));
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return out;
}

describe('link schemes (security)', () => {
  test.each([
    ['javascript:', '[click](javascript:alert(1))'],
    ['upper-case JavaScript:', '[click](JavaScript:alert(1))'],
    ['entity-obfuscated java&#9;script:', '[click](java&#9;script:alert(1))'],
    ['entity-obfuscated javascript&#58;', '[click](javascript&#58;alert(1))'],
    ['data:', '[click](data:text/html;base64,PHNjcmlwdD4=)'],
    ['vbscript:', '[click](vbscript:msgbox(1))'],
    ['search-ms:', '[click](search-ms:query=x&crumb=location:\\\\evil\\share)'],
    ['ms-settings:', '[click](ms-settings:privacy)'],
    ['file:', '[click](file:///etc/passwd)'],
    ['autolink javascript:', '<javascript:alert(1)>'],
    ['autolink file:', '<file://server/share>'],
  ])('%s keeps the text and drops the link', (_name, md) => {
    const doc = fromMarkdown(md);
    expect(hrefsOf(doc)).toEqual([]);
    expect(toMarkdown(doc)).not.toMatch(/\]\(|^<[a-z]/i);
  });

  test('the text of a dropped link survives as plain text', () => {
    expect(toMarkdown(fromMarkdown('See [the **docs**](javascript:alert(1)) now'))).toBe(
      'See the **docs** now',
    );
  });

  test.each([
    ['https', '[docs](https://example.com/a)', 'https://example.com/a'],
    ['http', '[docs](http://example.com)', 'http://example.com'],
    ['mailto', '[mail](mailto:anna@example.com)', 'mailto:anna@example.com'],
    ['bare URL', 'https://example.com/x', 'https://example.com/x'],
    ['relative path', '[here](/o/acme/my)', '/o/acme/my'],
  ])('%s links are kept', (_name, md, href) => {
    const doc = fromMarkdown(md);
    expect(hrefsOf(doc)).toContain(href);
    expect(toMarkdown(doc)).toBe(md);
  });

  test('isAllowedLinkHref', () => {
    for (const href of [
      'javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      ' javascript:alert(1)',
      '\u0001javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      'search-ms:query=x',
      'ms-excel:ofe|u|https://x',
      'file:///c:/x',
      'ftp://x.test',
      '',
      null,
      undefined,
    ]) {
      expect(isAllowedLinkHref(href), String(href)).toBe(false);
    }
    for (const href of [
      'https://x.test',
      'HTTP://x.test',
      'mailto:a@x.test',
      '/o/x/my',
      '#top',
      'x.test',
    ]) {
      expect(isAllowedLinkHref(href), href).toBe(true);
    }
  });
});

/** How deep blockquotes and lists nest in a parsed document. */
function depth(node: JSONContent): number {
  const inner = Math.max(0, ...(node.content ?? []).map(depth));
  const container = ['blockquote', 'bulletList', 'orderedList', 'taskList'].includes(
    node.type ?? '',
  );
  return inner + (container ? 1 : 0);
}

describe('pathological nesting (anyone in a shared org can store it)', () => {
  const deep = 5000;
  test.each([
    ['blockquotes', `${'> '.repeat(deep)}x`],
    ['quote markers without blanks', `${'>'.repeat(deep)}x`],
    ['bullet lists', `${'- '.repeat(deep)}x`],
    ['ordered lists', `${'1. '.repeat(deep)}x`],
    ['quotes and lists', `${'> - '.repeat(deep / 2)}x`],
    ['indentation', Array.from({ length: 450 }, (_, i) => `${'\t'.repeat(i)}- a`).join('\n')],
  ])('%s 5,000 deep parse and serialise without blowing the stack', (_name, markdown) => {
    const doc = fromMarkdown(markdown);
    expect(depth(doc)).toBeLessThanOrEqual(maxNesting * 2);
    expect(toMarkdown(doc)).toContain(markdown.includes('\t') ? 'a' : 'x');
  });

  test('the text past the limit stays, as text', () => {
    const markdown = `${'> '.repeat(maxNesting + 2)}x`;
    expect(boundNesting(markdown)).toBe(`${'> '.repeat(maxNesting)}\\> > x`);
    expect(depth(fromMarkdown(markdown))).toBe(maxNesting);
  });

  test('normal nesting and fenced code are left alone', () => {
    const fenced = [
      '```',
      ...Array.from({ length: 30 }, (_, i) => `${' '.repeat(i * 4)}> x`),
      '```',
    ];
    expect(boundNesting(fenced.join('\n'))).toBe(fenced.join('\n'));
    expect(boundNesting('> - 1. quote, list, item')).toBe('> - 1. quote, list, item');
  });
});
