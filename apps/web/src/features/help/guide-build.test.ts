// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
// The screenshot tools write what the guide reads: test the pair together.
import { writeShotMeta } from '../../../../../scripts/docs/png-meta.mjs';
import {
  buildGuide,
  checkAnchors,
  guideImage,
  guidePlugin,
  headingId,
  pngInfo,
  type RenderContext,
  renderGuideMarkdown,
} from './guide-build';
import { versionAnchor, whatsNewSlug } from './guide-model';

/** A PNG's signature and IHDR with the given size, then IEND (enough for `pngInfo`). */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(45);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(0, 33);
  bytes.write('IEND', 37, 'ascii');
  return bytes;
}

/** A throwaway repo: docs/guide/{en,sv}, docs/screenshots, docs/operator.md. */
function fixtureRepo(): { root: string; guideDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'rooster-guide-'));
  const guideDir = join(root, 'docs/guide');
  mkdirSync(join(guideDir, 'en'), { recursive: true });
  mkdirSync(join(guideDir, 'sv'), { recursive: true });
  mkdirSync(join(root, 'docs/screenshots'), { recursive: true });
  writeFileSync(join(root, 'docs/screenshots/today.desktop.light.png'), png(640, 300));
  writeFileSync(join(root, 'docs/operator.md'), '# Operator\n');
  writeFileSync(
    join(guideDir, 'pages.json'),
    JSON.stringify({
      pages: [
        { slug: 'getting-started', title: { en: 'Getting started', sv: 'Kom igång' } },
        { slug: 'reminders', title: { en: 'Reminders', sv: 'Påminnelser' } },
      ],
    }),
  );
  writeFileSync(
    join(guideDir, 'en/getting-started.md'),
    [
      '# Getting started',
      '',
      'Read [reminders](./reminders.md#add-one), the [operator guide](../../operator.md) and [the site](https://example.com).',
      '',
      '![Today](../../screenshots/today.desktop.light.png "Today view")',
      '',
      '## Basics',
      '',
      '## Basics',
      '',
      '| Key | Does |',
      '| --- | --- |',
      '| <kbd>N</kbd> | New task |',
    ].join('\n'),
  );
  writeFileSync(join(guideDir, 'en/reminders.md'), '# Reminders\n\nSoon.\n');
  writeFileSync(join(guideDir, 'sv/getting-started.md'), '# Kom igång\n\nHej.\n');
  return { root, guideDir };
}

function context(root: string, guideDir: string, warn = vi.fn()): RenderContext {
  return {
    file: join(guideDir, 'en/getting-started.md'),
    guideDir,
    repoRoot: root,
    slugs: new Set(['getting-started', 'reminders']),
    repoUrl: 'https://github.com/ebner/rooster',
    image: guideImage,
    warn,
  };
}

describe('the guide build (ADR 0052 §2)', () => {
  test('AC-11.6 links between pages become app routes; other links leave the app', () => {
    const { root, guideDir } = fixtureRepo();
    const markdown =
      'See [r](./reminders.md#add-one), [op](../../operator.md), [x](https://example.com).';
    const { html } = renderGuideMarkdown(markdown, context(root, guideDir));
    expect(html).toContain('<a href="/help/reminders#add-one" data-guide-link>r</a>');
    expect(html).toContain(
      '<a href="https://github.com/ebner/rooster/blob/main/docs/operator.md" target="_blank" rel="noopener noreferrer">op</a>',
    );
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  test('a link to a page that is not in pages.json keeps only its text, with a warning', () => {
    const { root, guideDir } = fixtureRepo();
    const warn = vi.fn();
    const { html } = renderGuideMarkdown('[gone](./gone.md)', context(root, guideDir, warn));
    expect(html).toBe('<p>gone</p>\n');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not in pages.json'));
  });

  test('images resolve to content-hashed build assets with their size', () => {
    const { root, guideDir } = fixtureRepo();
    const { html } = renderGuideMarkdown(
      '![Today](../../screenshots/today.desktop.light.png)',
      context(root, guideDir),
    );
    expect(html).toMatch(
      /<img src="\/assets\/guide\/today-desktop-light-[0-9a-f]{10}\.png" alt="Today" width="640" height="300" loading="lazy" decoding="async">/,
    );
  });

  test('a screenshot shows at its real size, a crop at the scale of its whole window', () => {
    const { root, guideDir } = fixtureRepo();
    const shots = join(root, 'docs/screenshots');
    writeFileSync(
      join(shots, 'a.phone.light.png'),
      writeShotMeta(png(786, 1318), { scale: 2, viewport: 393 }),
    );
    writeFileSync(
      join(shots, 'b.desktop.light.png'),
      writeShotMeta(png(2880, 1800), { scale: 2, viewport: 1440 }),
    );
    writeFileSync(
      join(shots, 'c.desktop.light.png'),
      writeShotMeta(png(2272, 2198), { scale: 2, viewport: 1440 }),
    );
    const md = ['a.phone', 'b.desktop', 'c.desktop']
      .map((n) => `![${n}](../../screenshots/${n}.light.png)`)
      .join('\n\n');
    const { html } = renderGuideMarkdown(md, context(root, guideDir));
    expect(html).toContain(
      'alt="a.phone" width="393" height="659" style="width: min(100%, 24.56rem)"',
    );
    expect(html).toContain(
      'alt="b.desktop" width="1440" height="900" style="width: min(100%, 90rem)"',
    );
    expect(html).toContain(
      'alt="c.desktop" width="1136" height="1099" style="width: min(78.9%, 71rem)"',
    );
  });

  test('a missing image renders its alt text and warns', () => {
    const { root, guideDir } = fixtureRepo();
    const warn = vi.fn();
    const { html } = renderGuideMarkdown(
      '![Inbox](../../screenshots/inbox.png)',
      context(root, guideDir, warn),
    );
    expect(html).toBe('<p>Inbox</p>\n');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('image not found'));
  });

  test('the first heading is the title (the app shows it), the rest get unique anchors', () => {
    const { root, guideDir } = fixtureRepo();
    const { title, html } = renderGuideMarkdown(
      '# Getting started\n\n## Due & dates\n\n## Due & dates\n',
      context(root, guideDir),
    );
    expect(title).toBe('Getting started');
    expect(html).not.toContain('<h1');
    expect(html).toContain('<h2 id="due--dates">Due &amp; dates</h2>');
    expect(html).toContain('<h2 id="due--dates-1">');
  });

  test('tables scroll in their own frame', () => {
    const { root, guideDir } = fixtureRepo();
    const { html } = renderGuideMarkdown('| a |\n| - |\n| 1 |', context(root, guideDir));
    expect(html).toMatch(/^<div class="guide-table"><table>[\s\S]*<\/table><\/div>$/m);
  });

  test('scripts, event handlers and javascript: links fail the build', () => {
    const { root, guideDir } = fixtureRepo();
    const ctx = context(root, guideDir);
    expect(() => renderGuideMarkdown('<script>alert(1)</script>', ctx)).toThrow(/not allowed/);
    expect(() => renderGuideMarkdown('<img src=x onerror="alert(1)">', ctx)).toThrow(/not allowed/);
    expect(() => renderGuideMarkdown('[x](javascript:alert(1))', ctx)).toThrow(/not allowed/);
    expect(() => renderGuideMarkdown('![x](https://example.com/a.png)', ctx)).toThrow(
      /repository files/,
    );
  });

  test('every page in pages.json order; a page missing in a locale falls back to English', () => {
    const { root, guideDir } = fixtureRepo();
    const guide = buildGuide({ guideDir, repoRoot: root, locale: 'sv', warn: vi.fn() });
    expect(guide.pages.map((p) => [p.slug, p.title, p.lang])).toEqual([
      ['getting-started', 'Kom igång', 'sv'],
      ['reminders', 'Reminders', 'en'],
    ]);
    expect(guide.pages[0]?.html).toBe('<p>Hej.</p>\n');
  });

  test('the virtual module exports the pages and emits each image once in a build', () => {
    const { root, guideDir } = fixtureRepo();
    const plugin = guidePlugin({ guideDir, repoRoot: root, locales: ['en', 'sv'] });
    const resolveId = plugin.resolveId as (id: string) => string | null;
    const load = plugin.load as (this: unknown, id: string) => string | null;
    const configResolved = plugin.configResolved as (config: { command: string }) => void;
    configResolved({ command: 'build' });
    expect(resolveId('virtual:rooster-guide/en')).toBe('\0virtual:rooster-guide/en');
    expect(resolveId('virtual:rooster-guide/de')).toBeNull();
    const emitFile = vi.fn();
    const ctx = { warn: vi.fn(), addWatchFile: vi.fn(), emitFile };
    const code = load.call(ctx, '\0virtual:rooster-guide/en') ?? '';
    load.call(ctx, '\0virtual:rooster-guide/en');
    const pages = JSON.parse(code.replace(/^export const pages = /, '').replace(/;\n$/, ''));
    expect(pages.map((p: { slug: string }) => p.slug)).toEqual(['getting-started', 'reminders']);
    expect(emitFile).toHaveBeenCalledTimes(1);
    expect(emitFile.mock.calls[0]?.[0]).toMatchObject({
      type: 'asset',
      fileName: expect.stringMatching(/^assets\/guide\/today-desktop-light-[0-9a-f]{10}\.png$/),
    });
  });

  test('heading ids are GitHub’s: Swedish letters kept, punctuation dropped, -1 for repeats', () => {
    const { root, guideDir } = fixtureRepo();
    const { html } = renderGuideMarkdown(
      [
        '## Återkommande uppgifter',
        '## Everyone’s tasks',
        "## Everyone's tasks",
        '## What a connection may do',
        '## Vad en anslutning får göra?',
        '## The `!15m` token',
      ].join('\n\n'),
      context(root, guideDir),
    );
    expect([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'återkommande-uppgifter',
      'everyones-tasks',
      'everyones-tasks-1',
      'what-a-connection-may-do',
      'vad-en-anslutning-får-göra',
      'the-15m-token',
    ]);
  });

  test('a link to a heading that does not exist is reported', () => {
    const warn = vi.fn();
    checkAnchors(
      [
        {
          slug: 'a',
          title: 'A',
          lang: 'sv',
          html: '<h2 id="gränser">x</h2><a href="#gränser">ok</a>',
        },
        {
          slug: 'b',
          title: 'B',
          lang: 'sv',
          html: '<a href="/help/a#gr%C3%A4nser">ok</a><a href="/help/a#saknas">broken</a>',
        },
      ],
      warn,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no heading #saknas on a'));
  });

  test.each(['en', 'sv'])(
    'AC-11.6 the real guide (%s) builds without a broken link, image or anchor',
    (locale) => {
      const root = join(import.meta.dirname, '../../../../..');
      const warn = vi.fn();
      const guide = buildGuide({
        guideDir: join(root, 'docs/guide'),
        repoRoot: root,
        repoUrl: 'https://github.com/ebner/rooster',
        locale,
        warn,
      });
      expect(warn.mock.calls).toEqual([]);
      expect(guide.pages.every((page) => page.lang === locale)).toBe(true);
    },
  );

  test("What's new: both languages list the same releases, newest first, at the app's anchors", () => {
    const root = join(import.meta.dirname, '../../../../..');
    const versions = (locale: string) => {
      const guide = buildGuide({ guideDir: join(root, 'docs/guide'), repoRoot: root, locale });
      const page = guide.pages.find((p) => p.slug === whatsNewSlug);
      return [...(page?.html ?? '').matchAll(/<h2 id="([^"]+)">([^<]+)<\/h2>/g)]
        .map(([, id = '', text = '']) => ({ id, text }))
        .filter(({ text }) => text !== 'Unreleased');
    };
    const en = versions('en');
    expect(en.length).toBeGreaterThan(0);
    expect(versions('sv')).toEqual(en);
    for (const { id, text } of en) {
      expect(text).toMatch(/^\d+\.\d+\.\d+$/);
      expect(id).toBe(versionAnchor(text));
      expect(headingId(text, new Map())).toBe(versionAnchor(text));
    }
    const rank = (version: string) =>
      version.split('.').reduce((sum, part) => sum * 1000 + Number(part), 0);
    const ranks = en.map(({ text }) => rank(text));
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  test('helpers: heading anchors keep Swedish letters, PNG sizes need a PNG', () => {
    expect(headingId('Återkommande uppgifter', new Map())).toBe('återkommande-uppgifter');
    expect(pngInfo(png(1440, 900))).toEqual({ width: 1440, height: 900, scale: 1, viewport: null });
    expect(pngInfo(writeShotMeta(png(786, 1318), { scale: 2, viewport: 393 }))).toEqual({
      width: 786,
      height: 1318,
      scale: 2,
      viewport: 393,
    });
    expect(pngInfo(new Uint8Array(40))).toBeNull();
  });
});
