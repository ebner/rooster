import { markSvg, wordmarkSvg } from './brand.ts';
import { copyFor, type Lang, langPrefix, repoUrl, type SiteContext } from './config.ts';
import { html, raw, type SafeHtml } from './html.ts';

export interface Page {
  /** Output path relative to the site root: `''`, `sv/`, `guide/reminders/` … */
  path: string;
  lang: Lang;
  /** The same page in the other language, when there is one. */
  alternate: string | null;
  title: string;
  description: string;
  body: SafeHtml;
  /** Draw the logo in (the start pages only). */
  animatedLogo?: boolean;
  /** Not in the sitemap, not indexed (the 404 page). */
  noindex?: boolean;
}

export const link = (site: Pick<SiteContext, 'base'>, path: string) => `${site.base}${path}`;

export function layout(site: SiteContext, page: Page): string {
  const copy = copyFor[page.lang];
  // One start page, in English (ADR 0070, amended 2026-11-18); the guide keeps both languages.
  const home = '';
  const guideHome = `${langPrefix(page.lang)}guide/`;
  const other: Lang = page.lang === 'en' ? 'sv' : 'en';
  const canonical = new URL(page.path, site.url).href;
  const ogImage = new URL('og.png', site.url).href;
  const otherHref = page.alternate === null ? '' : link(site, page.alternate);
  const alternates =
    page.alternate === null
      ? ''
      : html`<link rel="alternate" hreflang="${page.lang}" href="${canonical}">
    <link rel="alternate" hreflang="${other}" href="${new URL(page.alternate, site.url).href}">`;
  const onHome = page.path === home;
  const section = (id: string) => (onHome ? `#${id}` : `${link(site, home)}#${id}`);

  return `<!doctype html>
${html`<html lang="${page.lang}" data-print="site">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${page.title}</title>
    <meta name="description" content="${page.description}">
    ${page.noindex ? raw('<meta name="robots" content="noindex">') : html`<link rel="canonical" href="${canonical}">`}
    ${alternates}
    <meta name="theme-color" content="#FFFFFF">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="rooster">
    <meta property="og:title" content="${page.title}">
    <meta property="og:description" content="${page.description}">
    <meta property="og:url" content="${canonical}">
    <meta property="og:image" content="${ogImage}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${copy.meta.ogAlt}">
    <meta property="og:locale" content="${page.lang === 'sv' ? 'sv_SE' : 'en_GB'}">
    <meta name="twitter:card" content="summary_large_image">
    <link rel="icon" href="${link(site, 'favicon.svg')}" type="image/svg+xml">
    <link rel="apple-touch-icon" href="${link(site, 'apple-touch-icon.png')}">
    ${site.css.map((href) => html`<link rel="stylesheet" href="${href}">`)}
    <script type="module" src="${site.js}"></script>
  </head>
  <body>
    <a class="skip" href="#main">${copy.nav.skip}</a>
    <header class="site-header">
      <div class="wrap header-row">
        <a class="logo" href="${link(site, home)}" aria-label="rooster">
          ${markSvg({ size: 32, animated: page.animatedLogo === true, id: 'logo' })}
          ${wordmarkSvg(14.4)}
        </a>
        <nav aria-label="${copy.nav.menu}">
          <ul class="nav">
            <li class="nav-wide"><a href="${section('features')}">${copy.nav.features}</a></li>
            <li class="nav-wide"><a href="${section('self-host')}">${copy.nav.selfHost}</a></li>
            <li><a href="${link(site, guideHome)}">${copy.nav.guide}</a></li>
            <li><a href="${repoUrl}">${copy.nav.github}</a></li>
            ${page.alternate === null ? '' : html`<li><a class="lang" href="${otherHref}" hreflang="${other}" lang="${other}">${copy.otherLanguage}</a></li>`}
          </ul>
        </nav>
      </div>
    </header>
    <main id="main" tabindex="-1">
      ${page.body}
    </main>
    ${footer(site, page.lang)}
  </body>
</html>`}
`;
}

function footer(site: SiteContext, lang: Lang): SafeHtml {
  const copy = copyFor[lang].footer;
  const blob = (path: string) => `${repoUrl}/blob/main/${path}`;
  return html`<footer class="site-footer">
      <div class="wrap footer-grid">
        <div class="footer-brand">
          <a class="logo" href="${link(site, '')}" aria-label="rooster">
            ${markSvg({ size: 28, id: 'footer-logo' })}${wordmarkSvg(12.6)}
          </a>
          <p>${copy.tagline}</p>
        </div>
        <nav class="footer-links" aria-label="${copy.docs}">
          <h2>${copy.docs}</h2>
          <ul>
            <li><a href="${link(site, `${langPrefix(lang)}guide/`)}">${copy.userGuide}</a></li>
            <li><a href="${blob('docs/operator.md')}">${copy.operatorGuide}</a></li>
            <li><a href="${blob('docs/oidc-setup.md')}">${copy.signIn}</a></li>
            <li><a href="${blob('CHANGELOG.md')}">${copy.changelog}</a></li>
          </ul>
        </nav>
        <nav class="footer-links" aria-label="${copy.project}">
          <h2>${copy.project}</h2>
          <ul>
            <li><a href="${repoUrl}">${copy.source}</a></li>
            <li><a href="${blob('CONTRIBUTING.md')}">${copy.contributing}</a></li>
            <li><a href="${blob('SECURITY.md')}">${copy.security}</a></li>
            <li><a href="${blob('LICENSE')}">${copy.license}</a></li>
            <li><a href="${link(site, 'third-party-notices.txt')}">${copy.notices}</a></li>
          </ul>
        </nav>
      </div>
      <div class="wrap footer-legal"><p>${copy.copyright}</p></div>
    </footer>`;
}
