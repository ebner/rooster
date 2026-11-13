/**
 * The internal links and images of one built page that point at nothing: every `href`, `src`
 * and `srcset` URL is resolved against the page's own address, and those on the site (same
 * origin, under its base) must exist as a file (`exists`, given a path relative to the site
 * root; a path ending in `/` means its `index.html`).
 */
export function brokenLinks(
  source: string,
  pageUrl: URL,
  site: URL,
  exists: (path: string) => boolean,
): string[] {
  const broken: string[] = [];
  for (const [, attr, value = ''] of source.matchAll(/\s(href|src|srcset)="([^"]*)"/g)) {
    const targets =
      attr === 'srcset' ? value.split(',').map((s) => s.trim().split(/\s+/)[0] ?? '') : [value];
    for (const target of targets) {
      const raw = target.replace(/&amp;/g, '&');
      if (raw === '' || raw.startsWith('#')) continue;
      let url: URL;
      try {
        url = new URL(raw, pageUrl);
      } catch {
        broken.push(target);
        continue;
      }
      if (url.origin !== site.origin) continue;
      if (!url.pathname.startsWith(site.pathname)) {
        broken.push(target);
        continue;
      }
      const path = decodeURIComponent(url.pathname.slice(site.pathname.length));
      if (!exists(path === '' || path.endsWith('/') ? `${path}index.html` : path)) {
        broken.push(target);
      }
    }
  }
  return broken;
}
