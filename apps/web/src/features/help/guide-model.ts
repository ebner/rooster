/** One page of the user guide, as the build renders it (ADR 0052 §2). */
export interface GuidePage {
  slug: string;
  title: string;
  /** The page's language: the viewer's, or English when it isn't translated yet. */
  lang: string;
  /** Trusted HTML rendered at build time from docs/guide (never user content). */
  html: string;
}

/** The page before and after `slug` in the guide's order. */
export function neighbours(
  pages: readonly GuidePage[],
  slug: string,
): { previous: GuidePage | undefined; next: GuidePage | undefined } {
  const index = pages.findIndex((page) => page.slug === slug);
  if (index < 0) return { previous: undefined, next: undefined };
  return { previous: pages[index - 1], next: pages[index + 1] };
}

/** The "What's new" page: a `## X.Y.Z` section per release (ADR 0057). */
export const whatsNewSlug = 'whats-new';

/** The heading id of a version's section (`## 1.5.3` → `153`), as the guide build makes it. */
export function versionAnchor(version: string): string {
  return version.toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, '');
}

export interface GuideSearchParams {
  q?: string;
}

/**
 * The help routes' `validateSearch` (ADR 0058): an empty query is no query. It lives here, not
 * with the search view, because route options stay in the initial bundle.
 */
export function guideSearchParams(search: Record<string, unknown>): GuideSearchParams {
  return typeof search.q === 'string' && search.q !== '' ? { q: search.q } : {};
}
