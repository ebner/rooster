import { describe, expect, it } from 'vitest';
import {
  COMMENT_NESTING_MAX,
  type CommentBlock,
  type CommentInline,
  commentToMarkdown,
  commentToPlainText,
  isSafeHref,
  parseCommentMarkdown,
  parseInline,
} from '../src/comment-markdown.ts';
import { formatMention } from '../src/mentions.ts';

const ANNA = '01900000-0000-7000-8000-00000000000a';
const text = (t: string): CommentInline => ({ type: 'text', text: t });
const para = (...children: CommentInline[]): CommentBlock => ({ type: 'paragraph', children });

describe('blocks', () => {
  it('splits paragraphs on blank lines; single newlines are breaks', () => {
    expect(parseCommentMarkdown('One\ntwo\n\n\nThree\r\nfour')).toEqual([
      para(text('One'), { type: 'break' }, text('two')),
      para(text('Three'), { type: 'break' }, text('four')),
    ]);
    expect(parseCommentMarkdown('')).toEqual([]);
    expect(parseCommentMarkdown('  \n\t\n')).toEqual([]);
  });

  it('reads bulleted and numbered lists, with indented continuation lines', () => {
    expect(parseCommentMarkdown('- a\n* b\n  more\n+ c')).toEqual([
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [[text('a')], [text('b'), { type: 'break' }, text('more')], [text('c')]],
      },
    ]);
    expect(parseCommentMarkdown('3. three\n4) four')).toEqual([
      { type: 'list', ordered: true, start: 3, items: [[text('three')], [text('four')]] },
    ]);
  });

  it('switching list kinds or a blank line starts a new list; text ends a list', () => {
    const blocks = parseCommentMarkdown('- a\n1. b\n\n- c\nafter');
    expect(blocks.map((b) => (b.type === 'list' ? `${b.ordered}` : b.type))).toEqual([
      'false',
      'true',
      'false',
      'paragraph',
    ]);
  });

  it('only a list starting at 1 interrupts a paragraph', () => {
    expect(parseCommentMarkdown('In\n2024. it rained')).toEqual([
      para(text('In'), { type: 'break' }, text('2024. it rained')),
    ]);
    expect(parseCommentMarkdown('Steps\n1. go')[1]).toMatchObject({ type: 'list', start: 1 });
    expect(parseCommentMarkdown('Items\n- x')[1]).toMatchObject({ type: 'list', ordered: false });
  });

  it('reads fenced code blocks verbatim, closed or not', () => {
    expect(parseCommentMarkdown('```ts\nconst a = **b**;\n<b>x</b>\n```\nafter')).toEqual([
      { type: 'code_block', text: 'const a = **b**;\n<b>x</b>' },
      para(text('after')),
    ]);
    expect(parseCommentMarkdown('para\n~~~\nopen\n```\nstill')).toEqual([
      para(text('para')),
      { type: 'code_block', text: 'open\n```\nstill' },
    ]);
    expect(parseCommentMarkdown('````\n```\n````')).toEqual([{ type: 'code_block', text: '```' }]);
  });

  it('has no headings, quotes or rules: they stay text', () => {
    expect(parseCommentMarkdown('# Title\n> quote\n---')).toEqual([
      para(text('# Title'), { type: 'break' }, text('> quote'), { type: 'break' }, text('---')),
    ]);
  });
});

describe('inline', () => {
  it('bold, italic and their nesting', () => {
    expect(parseInline('**bold** and *it* and __b__ and _i_')).toEqual([
      { type: 'strong', children: [text('bold')] },
      text(' and '),
      { type: 'em', children: [text('it')] },
      text(' and '),
      { type: 'strong', children: [text('b')] },
      text(' and '),
      { type: 'em', children: [text('i')] },
    ]);
    expect(parseInline('***both***')).toEqual([
      { type: 'em', children: [{ type: 'strong', children: [text('both')] }] },
    ]);
    expect(parseInline('**a *b* c**')).toEqual([
      {
        type: 'strong',
        children: [text('a '), { type: 'em', children: [text('b')] }, text(' c')],
      },
    ]);
    expect(parseInline('*a**b*')).toEqual([{ type: 'em', children: [text('a**b')] }]);
  });

  it('leaves intraword underscores, lone and unmatched delimiters as text', () => {
    expect(parseInline('snake_case_name')).toEqual([text('snake_case_name')]);
    expect(parseInline('2 * 3 * 4')).toEqual([text('2 * 3 * 4')]);
    expect(parseInline('**open')).toEqual([text('**open')]);
    expect(parseInline('a* b*')).toEqual([text('a* b*')]);
    expect(parseInline('un*frigging*believable')).toEqual([
      text('un'),
      { type: 'em', children: [text('frigging')] },
      text('believable'),
    ]);
    expect(parseInline('*(x)*')).toEqual([{ type: 'em', children: [text('(x)')] }]);
  });

  it('inline code is verbatim and wins over emphasis', () => {
    expect(parseInline('use `a *b*` now')).toEqual([
      text('use '),
      { type: 'code', text: 'a *b*' },
      text(' now'),
    ]);
    expect(parseInline('`` a`b ``')).toEqual([{ type: 'code', text: 'a`b' }]);
    expect(parseInline('` x `')).toEqual([{ type: 'code', text: 'x' }]);
    expect(parseInline('`  `')).toEqual([{ type: 'code', text: '  ' }]);
    expect(parseInline('`open')).toEqual([text('`open')]);
    expect(parseInline('*a `*` b*')).toEqual([
      { type: 'em', children: [text('a '), { type: 'code', text: '*' }, text(' b')] },
    ]);
  });

  it('backslash escapes punctuation only', () => {
    expect(parseInline('\\*not\\* \\a \\\\')).toEqual([text('*not* \\a \\')]);
  });

  it('links with http, https and mailto; labels may be emphasised', () => {
    expect(parseInline('[the **docs**](https://example.com/a?b=1)')).toEqual([
      {
        type: 'link',
        href: 'https://example.com/a?b=1',
        children: [text('the '), { type: 'strong', children: [text('docs')] }],
      },
    ]);
    expect(parseInline('[mail](mailto:a@example.com)')).toEqual([
      { type: 'link', href: 'mailto:a@example.com', children: [text('mail')] },
    ]);
    // Brackets in a label are not supported: the URL is still linked.
    expect(parseInline('[a [b] c](https://x.test)')).toEqual([
      text('[a [b] c]('),
      { type: 'link', href: 'https://x.test', children: [text('https://x.test')] },
      text(')'),
    ]);
  });

  it('autolinks bare URLs without trailing punctuation', () => {
    expect(parseInline('See https://example.com/x, then (http://a.test/b_(c)).')).toEqual([
      text('See '),
      { type: 'link', href: 'https://example.com/x', children: [text('https://example.com/x')] },
      text(', then ('),
      { type: 'link', href: 'http://a.test/b_(c)', children: [text('http://a.test/b_(c)')] },
      text(').'),
    ]);
    expect(parseInline('xhttps://a.test')).toEqual([text('xhttps://a.test')]);
    expect(parseInline('https:///nohost')).toEqual([text('https:///nohost')]);
    expect(parseInline('[https://a.test](https://b.test)')).toEqual([
      { type: 'link', href: 'https://b.test', children: [text('https://a.test')] },
    ]);
  });

  it('mentions become mention nodes; malformed ones stay text', () => {
    const body = `Hi ${formatMention('Anna B', ANNA)}!`;
    expect(parseInline(body)).toEqual([
      text('Hi '),
      { type: 'mention', userId: ANNA, name: 'Anna B' },
      text('!'),
    ]);
    expect(parseInline('@[X](user:not-a-uuid-at-all-0000000000000000)')).toEqual([
      text('@[X](user:not-a-uuid-at-all-0000000000000000)'),
    ]);
    expect(parseInline(`**${formatMention('A', ANNA)}**`)).toEqual([
      { type: 'strong', children: [{ type: 'mention', userId: ANNA, name: 'A' }] },
    ]);
  });

  it('caps emphasis nesting', () => {
    const deep = `${'*_'.repeat(20)}x${'_*'.repeat(20)}`;
    const depth = (nodes: CommentInline[]): number =>
      Math.max(0, ...nodes.map((n) => ('children' in n ? 1 + depth(n.children) : 0)));
    expect(depth(parseInline(deep))).toBeLessThanOrEqual(COMMENT_NESTING_MAX);
  });

  it('stays fast on pathological input', () => {
    const started = performance.now();
    parseCommentMarkdown('*a '.repeat(6_000));
    parseCommentMarkdown('['.repeat(10_000));
    parseCommentMarkdown(`${'`'.repeat(5_000)}x`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('XSS corpus: no markup, no unsafe hrefs', () => {
  const corpus = [
    '[x](javascript:alert(1))',
    '[x](javascript:alert`1`)',
    '[x](JaVaScRiPt:alert)',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '[x](vbscript:msgbox)',
    '[x](//evil.example)',
    '[x](/relative)',
    '[x](https://ok.test"onmouseover="alert(1))',
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '**<b>bold</b>**',
    '*[x](javascript:alert(1))*',
    'javascript:alert(1)',
    'https://ok.test/<script>',
    '[x](https://ok.test\u0000x)',
    '@[<img src=x>](user:01900000-0000-7000-8000-00000000000a)',
    '```\n<script>x</script>\n```',
  ];

  const hrefs = (nodes: CommentInline[]): string[] =>
    nodes.flatMap((n) =>
      n.type === 'link' ? [n.href, ...hrefs(n.children)] : 'children' in n ? hrefs(n.children) : [],
    );
  const allHrefs = (blocks: CommentBlock[]) =>
    blocks.flatMap((b) =>
      b.type === 'paragraph' ? hrefs(b.children) : b.type === 'list' ? b.items.flatMap(hrefs) : [],
    );

  it.each(corpus)('%j', (body) => {
    const blocks = parseCommentMarkdown(body);
    for (const href of allHrefs(blocks)) {
      expect(isSafeHref(href)).toBe(true);
      expect(href).toMatch(/^(https?:\/\/|mailto:)/i);
    }
    // Every character of the input is still there as text (nothing became markup).
    expect(JSON.stringify(blocks)).not.toMatch(/"type":"(html|raw)"/);
  });

  it('keeps an unsafe link as its literal text', () => {
    expect(parseInline('[x](vbscript:msgbox)')).toEqual([text('[x](vbscript:msgbox)')]);
    expect(parseInline('<b>x</b>')).toEqual([text('<b>x</b>')]);
    expect(isSafeHref('https://a.test/\u0007')).toBe(false);
    expect(isSafeHref('HTTPS://A.TEST')).toBe(true);
  });
});

describe('plain text and round trips', () => {
  it('renders plain text with mentions as @Name', () => {
    const body = `**Hi** ${formatMention('Anna', ANNA)}\n\n- one\n- [two](https://a.test)\n\n\`\`\`\ncode\n\`\`\``;
    expect(commentToPlainText(parseCommentMarkdown(body))).toBe('Hi @Anna\n\none\ntwo\n\ncode');
  });

  const corpus = [
    'Plain text',
    'Two\nlines',
    'Para one\n\nPara two',
    '**bold** *em* ***both*** **a *b* c**',
    '*a**b*',
    '__under__ _score_ snake_case',
    'Use `code` and `` a`b `` and `` `x` ``',
    '` padded `',
    '[label](https://example.com) and https://bare.example/x.',
    '[https://a.test](https://b.test)',
    'x[link](https://a.test)y',
    `Hi ${formatMention('Anna', ANNA)}, see [docs](mailto:a@b.test)`,
    '- one\n- two\n  continued\n- *three*',
    '7. seven\n8. eight',
    'Para\n2. not a list\n- but this is',
    '```\nconst x = 1;\n```\n\nAfter',
    '````\n```\n````',
    '\\*escaped\\* \\[x\\](https://a.test)',
    '[x](javascript:alert(1)) <b>tag</b>',
    '1\\. escaped marker',
    '\\- escaped bullet',
    '\\~~~ not a fence',
    'a * b * c',
    'https://en.wikipedia.org/wiki/Foo_(bar) end',
    '    - deep\n- real',
    '- item\n      - nested-looking text',
  ];

  it.each(corpus)('%j', (body) => {
    const ast = parseCommentMarkdown(body);
    expect(parseCommentMarkdown(commentToMarkdown(ast))).toEqual(ast);
  });
});
