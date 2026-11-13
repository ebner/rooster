import { copyFor, type Lang, langPrefix, repoUrl, type SiteContext } from './config.ts';
import { html, inline, raw, type SafeHtml } from './html.ts';
import { icon } from './icons.ts';
import { link, type Page } from './layout.ts';

export interface GuidePageInput {
  slug: string;
  title: string;
  /** The page's language: the requested one, or English when the file is missing. */
  lang: string;
  /** The rendered Markdown (`renderGuideMarkdown` in apps/web, shared with the app's /help). */
  html: string;
}

/**
 * The app's guide HTML links pages as `/help/<slug>` and images as `/assets/guide/<file>`;
 * on the site they live under the language's `guide/` and the site's base.
 */
export function rebaseGuideHtml(source: string, site: SiteContext, lang: Lang): string {
  const guideBase = link(site, `${langPrefix(lang)}guide/`);
  return source
    .replace(
      /href="\/help\/([a-z0-9-]+)(#[^"]*)?"/g,
      (_, slug: string, hash = '') => `href="${guideBase}${slug}/${hash}"`,
    )
    .replace(/src="\/assets\/guide\//g, `src="${link(site, 'assets/guide/')}`);
}

function sidebar(site: SiteContext, lang: Lang, current: string | null): SafeHtml {
  const copy = copyFor[lang].guide;
  const base = `${langPrefix(lang)}guide/`;
  return html`<nav class="guide-nav" aria-label="${copy.pages}">
    <p class="guide-nav-title"><a href="${link(site, base)}"${raw(current === null ? ' aria-current="page"' : '')}>${copy.title}</a></p>
    <ol>
      ${site.guidePages.map((p) => {
        const title = p.title[lang] ?? p.title.en ?? p.slug;
        const here = p.slug === current ? raw(' aria-current="page"') : '';
        return html`<li><a href="${link(site, `${base}${p.slug}/`)}"${here}>${title}</a></li>`;
      })}
    </ol>
  </nav>`;
}

export function guideIndexPage(site: SiteContext, lang: Lang): Page {
  const copy = copyFor[lang];
  const other: Lang = lang === 'en' ? 'sv' : 'en';
  const base = `${langPrefix(lang)}guide/`;
  const body = html`<div class="wrap guide">
    ${sidebar(site, lang, null)}
    <article class="guide-article">
      <h1>${copy.guide.title}</h1>
      <p class="lead">${inline(copy.guide.intro)}</p>
      <ol class="guide-index">
        ${site.guidePages.map((p) => html`<li><a href="${link(site, `${base}${p.slug}/`)}">${p.title[lang] ?? p.title.en}${icon('arrow-right')}</a></li>`)}
      </ol>
    </article>
  </div>`;
  return {
    path: base,
    lang,
    alternate: `${langPrefix(other)}guide/`,
    title: `${copy.guide.title} · rooster`,
    description: copy.guide.intro.replace(/`/g, ''),
    body,
  };
}

export function guidePage(
  site: SiteContext,
  lang: Lang,
  page: GuidePageInput,
  index: number,
  description: string,
): Page {
  const copy = copyFor[lang].guide;
  const other: Lang = lang === 'en' ? 'sv' : 'en';
  const base = `${langPrefix(lang)}guide/`;
  const prev = site.guidePages[index - 1];
  const next = site.guidePages[index + 1];
  const titleOf = (p: { slug: string; title: Record<string, string> }) =>
    p.title[lang] ?? p.title.en ?? p.slug;
  const body = html`<div class="wrap guide">
    ${sidebar(site, lang, page.slug)}
    <article class="guide-article"${raw(page.lang !== lang ? ` lang="${page.lang}"` : '')}>
      <h1>${page.title}</h1>
      <div class="guide-body">${raw(rebaseGuideHtml(page.html, site, lang))}</div>
      <nav class="pager" aria-label="${copy.pages}">
        ${prev ? html`<a class="pager-prev" href="${link(site, `${base}${prev.slug}/`)}"><span>${copy.previous}</span>${titleOf(prev)}</a>` : raw('<span></span>')}
        ${next ? html`<a class="pager-next" href="${link(site, `${base}${next.slug}/`)}"><span>${copy.next}</span>${titleOf(next)}</a>` : ''}
      </nav>
      <p class="edit"><a href="${`${repoUrl}/blob/main/docs/guide/${page.lang}/${page.slug}.md`}">${copy.edit}</a></p>
    </article>
  </div>`;
  return {
    path: `${base}${page.slug}/`,
    lang,
    alternate: `${langPrefix(other)}guide/${page.slug}/`,
    title: `${page.title} · ${copy.title} · rooster`,
    description,
    body,
  };
}
