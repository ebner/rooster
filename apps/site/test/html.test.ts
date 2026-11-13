import { describe, expect, it } from 'vitest';
import type { SiteContext } from '../src/config.ts';
import { rebaseGuideHtml } from '../src/guide.ts';
import { fill, html, inline, raw } from '../src/html.ts';

describe('html', () => {
  it('escapes interpolations and passes nested html through', () => {
    const inner = html`<b>${'<i>'}</b>`;
    expect(html`<p title="${'"x"'}">${inner}${['a', '&']}${false}${null}</p>`.value).toBe(
      '<p title="&quot;x&quot;"><b>&lt;i&gt;</b>a&amp;</p>',
    );
    expect(html`${raw('<br>')}`.value).toBe('<br>');
  });

  it('turns the copy markup into tags after escaping', () => {
    expect(inline('Type `#tag` **now** and *then* <x>').value).toBe(
      'Type <code>#tag</code> <strong>now</strong> and <em>then</em> &lt;x&gt;',
    );
  });

  it('fills placeholders', () => {
    expect(fill('Version {version} {missing}', { version: '1.2.3' })).toBe('Version 1.2.3 ');
  });
});

describe('guide links', () => {
  const site = { base: '/rooster/' } as SiteContext;

  it('moves the app paths under the site base and the language', () => {
    const source =
      '<a href="/help/reminders#snooze" data-guide-link>x</a> <a href="/help/my-tasks">y</a> <img src="/assets/guide/shot-1.png">';
    expect(rebaseGuideHtml(source, site, 'sv')).toBe(
      '<a href="/rooster/sv/guide/reminders/#snooze" data-guide-link>x</a> <a href="/rooster/sv/guide/my-tasks/">y</a> <img src="/rooster/assets/guide/shot-1.png">',
    );
    expect(rebaseGuideHtml('<a href="/help/my-tasks">y</a>', site, 'en')).toBe(
      '<a href="/rooster/guide/my-tasks/">y</a>',
    );
  });
});
