import type { Copy } from './copy/en.ts';
import { en } from './copy/en.ts';
import { sv } from './copy/sv.ts';

export const repoUrl = 'https://github.com/ebner/rooster';

/** Where the site is published; only `SITE_URL` changes for a custom domain (ADR 0070). */
export const defaultSiteUrl = 'https://ebner.github.io/rooster/';

export function siteUrl(env: NodeJS.ProcessEnv = process.env): URL {
  const url = new URL(env.SITE_URL || defaultSiteUrl);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export type Lang = 'en' | 'sv';

export const languages: readonly Lang[] = ['en', 'sv'];

export const copyFor: Record<Lang, Copy> = { en, sv };

/** The path prefix of a language, relative to the site's base: English is the root. */
export const langPrefix = (lang: Lang) => (lang === 'en' ? '' : `${lang}/`);

/** A responsive screenshot, after the build has converted it. */
export interface ImageSet {
  src: string;
  srcset: string;
  /** CSS px: the screenshot's window size. */
  width: number;
  height: number;
}

export interface SiteContext {
  /** Absolute URL of the site's root, ending in `/`. */
  url: URL;
  /** `url`'s path, used for every internal link. */
  base: string;
  version: string;
  css: string[];
  js: string;
  images: ReadonlyMap<string, ImageSet>;
  /** The guide's pages in order, with their titles per language. */
  guidePages: readonly { slug: string; title: Record<string, string> }[];
}
