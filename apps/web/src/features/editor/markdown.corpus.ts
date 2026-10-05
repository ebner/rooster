/**
 * Markdown round-trip corpus (10 §3.5): 40 descriptions that must survive
 * `md → editor document → md`. A sample without `expected` must come back
 * byte-identical. A sample with `expected` is written in a non-canonical style and
 * must come back in exactly that canonical form, which may differ from the input
 * only by these documented normalisations:
 *
 * N1. List bullets are written `-` (from `*` or `+`).
 * N2. Emphasis is written `*italic*` and `**bold**` (from `_` and `__`).
 * N3. Code blocks are fenced with ``` (from `~~~` or 4-space indentation).
 * N4. Ordered lists are numbered consecutively from their first number
 *     (`1. 1. 1.` becomes `1. 2. 3.`).
 * N5. A hard break is written as two trailing spaces (from a trailing `\`);
 *     other trailing whitespace is dropped.
 * N6. Autolinks are written bare (`<https://x.test>` becomes `https://x.test`).
 * N7. A thematic break is written `---` (from `***` or `___`).
 * N8. Leading and trailing blank lines are dropped. (Extra blank lines between
 *     blocks are kept: they are empty paragraphs in the editor.)
 *
 * Escaping is minimal (see `escapeMarkdownText`), so text such as `snake_case`,
 * `2 * 3`, `Tom & Jerry` or `[ref]` is written as typed, and raw HTML is kept as
 * literal text rather than interpreted.
 */
export interface CorpusSample {
  name: string;
  md: string;
  /** The canonical form, when it differs from `md` (one of N1–N8 applies). */
  expected?: string;
}

const longLine = `This is a deliberately long line that keeps going without any manual wrapping so that the editor has to soft-wrap it on screen while the stored Markdown stays on one line, which matters for diffs, for the CLI and for anyone who reads the raw description in an email notification or a terminal window at eighty columns.`;

export const markdownCorpus: readonly CorpusSample[] = [
  { name: 'plain paragraph', md: 'Call Anna about the Q3 budget before Friday.' },
  { name: 'two paragraphs', md: 'First paragraph.\n\nSecond paragraph.' },
  {
    name: 'headings H1–H3',
    md: '# Heading one\n\n## Heading two\n\n### Heading three\n\nBody text.',
  },
  { name: 'italic and bold', md: 'Some *italic*, **bold** and ***both*** text.' },
  {
    name: 'underscore emphasis (N2)',
    md: 'Some _italic_ and __bold__ text.',
    expected: 'Some *italic* and **bold** text.',
  },
  {
    name: 'nested emphasis',
    md: '**Bold with *italic* inside** and *italic with **bold** inside*.',
  },
  { name: 'strike and inline code', md: '~~Old plan~~ and `pnpm build` now.' },
  { name: 'inline code containing a backtick', md: 'Type ``a `tick` here`` to quote.' },
  { name: 'inline code with markdown chars', md: 'Run `rm -rf *_tmp` and `[x](y)` literally.' },
  { name: 'link', md: 'Read [the docs](https://example.com/docs).' },
  {
    name: 'link with title',
    md: 'See [the spec](https://example.com/spec "Rooster spec") for details.',
  },
  { name: 'link with bold text', md: 'Open [**the board**](https://example.com/board) now.' },
  { name: 'bare URL', md: 'Ticket: https://example.com/issues/42_a' },
  {
    name: 'angle autolink (N6)',
    md: 'Docs: <https://example.com/docs>',
    expected: 'Docs: https://example.com/docs',
  },
  { name: 'email autolink', md: 'Mail anna@example.com today' },
  { name: 'bullet list', md: '- Milk\n- Eggs\n- Bread' },
  { name: 'star bullets (N1)', md: '* Milk\n* Eggs', expected: '- Milk\n- Eggs' },
  {
    name: 'nested bullet list',
    md: '- Fruit\n  - Apples\n  - Pears\n- Vegetables\n  - Carrots\n    - Orange ones',
  },
  { name: 'ordered list', md: '1. First\n2. Second\n3. Third' },
  { name: 'ordered list starting at 3', md: '3. Three\n4. Four\n5. Five' },
  {
    name: 'ordered list with repeated numbers (N4)',
    md: '1. One\n1. Two\n1. Three',
    expected: '1. One\n2. Two\n3. Three',
  },
  { name: 'ordered list nested in bullets', md: '- Steps\n  1. Open\n  2. Close' },
  { name: 'bullets nested in ordered list', md: '1. Prepare\n   - Coffee\n   - Notes\n2. Present' },
  { name: 'task list', md: '- [ ] Draft agenda\n- [x] Book room' },
  {
    name: 'nested task list',
    md: '- [ ] Release\n  - [x] Changelog\n  - [ ] Tag\n- [ ] Announce',
  },
  { name: 'code block with language', md: '```ts\nconst answer = 42;\nconsole.log(answer);\n```' },
  { name: 'code block without language', md: '```\nplain *code*\n  indented # line\n```' },
  {
    name: 'tilde and indented code blocks (N3)',
    md: '~~~python\nprint("hej")\n~~~\n\n    let x = 1;',
    expected: '```python\nprint("hej")\n```\n\n```\nlet x = 1;\n```',
  },
  { name: 'blockquote', md: '> Quoted text that\n> continues here.' },
  { name: 'blockquote with list', md: '> Notes:\n>\n> - one\n> - two' },
  {
    name: 'thematic breaks (N7)',
    md: 'Above\n\n---\n\nMiddle\n\n***\n\nBelow',
    expected: 'Above\n\n---\n\nMiddle\n\n---\n\nBelow',
  },
  {
    name: 'escaped block syntax at line start',
    md: '\\# Not a heading\n\n\\- not a list\n\n1\\. not ordered\n\n\\> not a quote\n\n\\[ ] not a task',
  },
  {
    name: 'escaped inline syntax',
    md: 'Literal \\*stars\\*, \\_underscores\\_, \\`ticks\\` and \\[not](a link).',
  },
  {
    name: 'plain characters that need no escaping',
    md: 'snake_case_name, 2 * 3 = 6, Tom & Jerry <3, a < b > c, [ref] and C:\\Users\\anna',
  },
  {
    name: 'Swedish text',
    md: '## Översikt\n\nRing Åsa om mötet på fredag. Glöm inte äpplena!\n\n- Köp mjölk\n- Städa förrådet',
  },
  { name: 'emoji', md: 'Ship it 🚀 and celebrate 🎉👍🏽 with the 🇸🇪 team.' },
  { name: 'long line', md: longLine },
  {
    name: 'hard breaks (N5)',
    md: 'First line  \nSecond line\\\nThird line \n\nNext paragraph',
    expected: 'First line  \nSecond line  \nThird line\n\nNext paragraph',
  },
  { name: 'raw HTML stays literal', md: 'Use <b>bold</b> and <script>alert(1)</script> as text.' },
  {
    name: 'mixed document (N8)',
    md: '\n\n# Plan\n\nIntro with a [link](https://example.com).\n\n\n- [x] Done\n- [ ] Todo\n\n> Remember **this**.\n\n```sh\npnpm test\n```\n\n',
    expected:
      '# Plan\n\nIntro with a [link](https://example.com).\n\n- [x] Done\n- [ ] Todo\n\n> Remember **this**.\n\n```sh\npnpm test\n```',
  },
];
