import { describe, expect, it } from 'vitest';
import { brokenLinks } from '../src/link-check.ts';

const site = new URL('https://ebner.github.io/rooster/');
const files = new Set([
  'index.html',
  'guide/index.html',
  'guide/reminders/index.html',
  'img/a.webp',
]);
const check = (html: string, page = 'guide/reminders/') =>
  brokenLinks(html, new URL(page, site), site, (path) => files.has(path));

describe('the link check', () => {
  it('accepts links that resolve to built files', () => {
    expect(
      check(
        '<a href="/rooster/guide/">x</a><a href="../">y</a><a href="#top">z</a><img src="/rooster/img/a.webp" srcset="/rooster/img/a.webp 1x, ../../img/a.webp 2x"><a href="https://github.com/x">gh</a>',
      ),
    ).toEqual([]);
  });

  it('finds broken root-relative, relative and absolute same-site links', () => {
    expect(
      check(
        '<a href="/rooster/nope/">a</a><a href="missing/">b</a><a href="https://ebner.github.io/rooster/gone/">c</a><img srcset="/rooster/img/b.webp 2x">',
      ),
    ).toEqual([
      '/rooster/nope/',
      'missing/',
      'https://ebner.github.io/rooster/gone/',
      '/rooster/img/b.webp',
    ]);
  });

  it('flags same-origin links outside the site', () => {
    expect(check('<a href="/other-project/">x</a>')).toEqual(['/other-project/']);
  });
});
