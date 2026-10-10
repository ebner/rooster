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
