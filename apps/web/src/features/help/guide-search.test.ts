import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildGuide } from './guide-build';
import type { GuidePage } from './guide-model';
import { fold, type Highlighted, pageSections, queryWords, searchGuide } from './guide-search';

const root = join(import.meta.dirname, '../../../../..');
const realGuide = (locale: string) =>
  buildGuide({ guideDir: join(root, 'docs/guide'), repoRoot: root, locale, warn: () => {} }).pages;

const page = (slug: string, title: string, html: string): GuidePage => ({
  slug,
  title,
  lang: 'en',
  html,
});

const pages = [
  page(
    'dates',
    'Dates',
    '<p>Give a task a due date.</p><h2 id="repeating-tasks">Repeating tasks</h2><p>A task can repeat <strong>every week</strong> &amp; more.</p><h3 id="skip">Skip</h3><p>Skip one occurrence.</p>',
  ),
  page(
    'reminders',
    'Reminders',
    '<h2 id="add">Add a reminder</h2><p>Type <code>!15m</code> for a reminder before the due time.</p>',
  ),
  page(
    'sv',
    'Återkommande',
    '<h2 id="återkommande-uppgifter">Återkommande uppgifter</h2><p>Varje vecka.</p>',
  ),
];

const text = (parts: readonly Highlighted[]) => parts.map((p) => p.text).join('');
const marks = (parts: readonly Highlighted[]) => parts.filter((p) => p.match).map((p) => p.text);

describe('searching the guide (ADR 0058)', () => {
  test('a page splits at its h2 and h3 headings, with the text before them first', () => {
    expect(pageSections(pages[0] as GuidePage)).toEqual([
      expect.objectContaining({ id: null, heading: null, text: 'Give a task a due date.' }),
      expect.objectContaining({
        id: 'repeating-tasks',
        heading: 'Repeating tasks',
        text: 'A task can repeat every week & more.',
      }),
      expect.objectContaining({ id: 'skip', heading: 'Skip', text: 'Skip one occurrence.' }),
    ]);
    // A page that starts with a heading has no empty opening section.
    expect(pageSections(pages[1] as GuidePage).map((s) => s.id)).toEqual(['add']);
  });

  test('folding keeps one character for one, so matches map back onto the original', () => {
    expect(fold('Återkommande ÖVER')).toBe('aterkommande over');
    expect(fold('Återkommande').length).toBe('Återkommande'.length);
    expect(queryWords('  Every  WEEK every ')).toEqual(['every', 'week']);
    expect(queryWords('   ')).toEqual([]);
  });

  test('a section matches when it has every word; a heading match ranks first', () => {
    const results = searchGuide(pages, 'repeat');
    expect(results.map((r) => r.section.id)).toEqual(['repeating-tasks']);
    expect(marks(results[0]?.title ?? [])).toEqual(['Repeat']);
    expect(searchGuide(pages, 'repeat week').map((r) => r.section.id)).toEqual(['repeating-tasks']);
    expect(searchGuide(pages, 'repeat reminder')).toEqual([]);
    // "reminder" is in the Reminders heading and in no other section.
    expect(searchGuide(pages, 'reminder').map((r) => r.section.slug)).toEqual(['reminders']);
    // The due date: the Dates intro and the reminder text; the intro's page title is "Dates".
    expect(searchGuide(pages, 'due').map((r) => r.section.slug)).toEqual(['dates', 'reminders']);
  });

  test('accents are ignored, and the snippet marks the matches in the original text', () => {
    const [hit] = searchGuide(pages, 'aterkommande');
    expect(hit?.section.id).toBe('återkommande-uppgifter');
    expect(marks(hit?.title ?? [])).toEqual(['Återkommande']);
    const [skip] = searchGuide(pages, 'occurrence');
    expect(text(skip?.snippet ?? [])).toBe('Skip one occurrence.');
    expect(marks(skip?.snippet ?? [])).toEqual(['occurrence']);
  });

  test('inline markup leaves no gap before punctuation; a block leaves a space', () => {
    const [hit] = searchGuide(
      [
        page(
          'p',
          'P',
          '<p>Choose <strong>Done</strong>, then <code>q</code>.</p><ul><li>One</li><li>Two</li></ul>',
        ),
      ],
      'done',
    );
    expect(text(hit?.snippet ?? [])).toBe('Choose Done, then q. One Two');
  });

  test('the snippet starts at the sentence of the match when it is near', () => {
    const html = `<p>${'Filler words here. '.repeat(10)}The needle sits in this sentence.</p>`;
    const [hit] = searchGuide([page('s', 'S', html)], 'needle');
    expect(text(hit?.snippet ?? [])).toMatch(/^…The needle sits in this sentence\.$/);
  });

  test('a long text is cut around the first match, at word boundaries', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const [hit] = searchGuide([page('long', 'Long', `<p>${words} needle ${words}</p>`)], 'needle');
    const snippet = text(hit?.snippet ?? []);
    expect(snippet.startsWith('…word')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain(' needle ');
    expect(snippet.length).toBeLessThan(200);
    expect(snippet).not.toMatch(/…\S*\d…/);
  });

  test('the real guide: the terminal app is found as "TUI", in both languages', () => {
    for (const [locale, reminder] of [
      ['en', 'reminder'],
      ['sv', 'påminnelse'],
    ] as const) {
      const guide = realGuide(locale);
      const [first] = searchGuide(guide, 'tui');
      expect(first?.section.slug, locale).toBe('cli-tui-mcp');
      expect(searchGuide(guide, reminder)[0]?.section.slug, locale).toBe('reminders');
      // Every result links to a heading that exists on its page.
      for (const { section } of searchGuide(guide, 'task')) {
        if (section.id === null) continue;
        const html = guide.find((p) => p.slug === section.slug)?.html ?? '';
        expect(html).toContain(` id="${section.id}"`);
      }
    }
    expect(searchGuide(realGuide('sv'), 'aterkommande').length).toBeGreaterThan(0);
  });
});
