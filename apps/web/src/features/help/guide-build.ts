import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { Marked, type Tokens } from 'marked';
import type { Plugin } from 'vite';

/**
 * The in-app guide, built from the trusted Markdown in `docs/guide/` (ADR 0052 §2). This module
 * runs in Vite (the `guidePlugin`), never in the browser: the app only ever receives the HTML.
 */

export interface GuidePageMeta {
  slug: string;
  title: Record<string, string>;
}

export interface GuideManifest {
  pages: GuidePageMeta[];
}

/** One rendered page of the `virtual:rooster-guide/<locale>` module. */
export interface RenderedGuidePage {
  slug: string;
  title: string;
  /** The page's language: the requested one, or English when that file is missing. */
  lang: string;
  html: string;
}

export interface GuideImage {
  /** Absolute path of the source image. */
  file: string;
  /** Served path, `/assets/guide/<name>-<hash>.<ext>`. */
  url: string;
  /** File name under `assets/guide/`. */
  fileName: string;
}

export interface RenderContext {
  /** Absolute path of the Markdown file (links and images resolve against it). */
  file: string;
  /** Absolute path of `docs/guide`. */
  guideDir: string;
  /** Absolute path of the repository root (for links to other repo files). */
  repoRoot: string;
  /** Slugs of the guide's pages. */
  slugs: ReadonlySet<string>;
  /** `https://github.com/<owner>/<repo>`: other repo files link there; without it, plain text. */
  repoUrl?: string | undefined;
  /** Resolves an image file to its served URL (and registers it for the build). */
  image: (file: string) => GuideImage;
  warn: (message: string) => void;
}

export interface RenderedMarkdown {
  /** The text of the first `#` heading (the page title in the file). */
  title: string | null;
  /** HTML without that heading: the app shows the title in its own header. */
  html: string;
}

export const guideImageBase = '/assets/guide/';

const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

export function imageContentType(file: string): string | undefined {
  return imageTypes[extname(file).toLowerCase()];
}

const escapeMap: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => escapeMap[c] ?? c);
}

/** GitHub-style heading anchors ("Due dates & times" → `due-dates--times`), kept unique. */
export function headingId(text: string, used: Map<string, number>): string {
  const base =
    text
      .replace(/<[^>]*>/g, '')
      .replace(/&[a-z0-9#]+;/gi, '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-') || 'section';
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/** Width and height of a PNG (IHDR) so the page doesn't jump while an image loads. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const unsafeHtml = /<\s*(script|iframe|object|embed|form|style)\b|\son[a-z]+\s*=|javascript:/i;
const scheme = /^[a-z][a-z0-9+.-]*:/i;

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !scheme.test(rel);
}

type LinkTarget =
  | { kind: 'guide'; href: string }
  | { kind: 'anchor'; href: string }
  | { kind: 'external'; href: string }
  | { kind: 'none' };

/** Where a Markdown link goes in the app (`./reminders.md#x` → `/help/reminders#x`). */
export function resolveLink(href: string, ctx: RenderContext): LinkTarget {
  if (href.startsWith('#')) return { kind: 'anchor', href };
  if (scheme.test(href)) {
    if (/^(https?|mailto):/i.test(href)) return { kind: 'external', href };
    throw new Error(`${ctx.file}: link scheme not allowed in the guide: ${href}`);
  }
  const [path = '', hash] = href.split('#', 2);
  const fragment = hash ? `#${hash}` : '';
  const target = resolve(dirname(ctx.file), decodeURI(path));
  if (isInside(target, ctx.guideDir) && target.endsWith('.md')) {
    const slug = basename(target, '.md');
    if (ctx.slugs.has(slug)) return { kind: 'guide', href: `/help/${slug}${fragment}` };
    ctx.warn(`${ctx.file}: link to a page that is not in pages.json: ${href}`);
    return { kind: 'none' };
  }
  if (ctx.repoUrl && isInside(target, ctx.repoRoot) && existsSync(target)) {
    const repoPath = relative(ctx.repoRoot, target).split(sep).join('/');
    return { kind: 'external', href: `${ctx.repoUrl}/blob/main/${repoPath}${fragment}` };
  }
  ctx.warn(`${ctx.file}: link target is not part of the guide: ${href}`);
  return { kind: 'none' };
}

/** Markdown → HTML for one guide page (build time, trusted repository content). */
export function renderGuideMarkdown(markdown: string, ctx: RenderContext): RenderedMarkdown {
  const usedIds = new Map<string, number>();
  let title: string | null = null;
  const marked = new Marked({ gfm: true, async: false });
  marked.use({
    walkTokens(token) {
      if ((token.type === 'html' || token.type === 'tag') && unsafeHtml.test(token.raw)) {
        throw new Error(`${ctx.file}: HTML not allowed in the guide: ${token.raw.trim()}`);
      }
    },
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        if (depth === 1 && title === null) {
          title = inner.replace(/<[^>]*>/g, '');
          return '';
        }
        return `<h${depth} id="${headingId(inner, usedIds)}">${inner}</h${depth}>\n`;
      },
      link({ href, title: linkTitle, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const target = resolveLink(href, ctx);
        const titleAttr = linkTitle ? ` title="${escapeHtml(linkTitle)}"` : '';
        switch (target.kind) {
          case 'none':
            return inner;
          case 'guide':
            return `<a href="${escapeHtml(target.href)}" data-guide-link${titleAttr}>${inner}</a>`;
          case 'anchor':
            return `<a href="${escapeHtml(target.href)}"${titleAttr}>${inner}</a>`;
          case 'external':
            return `<a href="${escapeHtml(target.href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${inner}</a>`;
        }
      },
      image({ href, title: imageTitle, text }: Tokens.Image) {
        const alt = escapeHtml(text);
        if (scheme.test(href)) {
          throw new Error(`${ctx.file}: images must be repository files, not ${href}`);
        }
        const file = resolve(dirname(ctx.file), decodeURI(href.split('#')[0] ?? ''));
        if (!isInside(file, ctx.repoRoot) || !existsSync(file) || !imageContentType(file)) {
          ctx.warn(`${ctx.file}: image not found or not an image: ${href}`);
          return alt;
        }
        const image = ctx.image(file);
        const size = file.toLowerCase().endsWith('.png') ? pngSize(readFileSync(file)) : null;
        const dims = size ? ` width="${size.width}" height="${size.height}"` : '';
        const titleAttr = imageTitle ? ` title="${escapeHtml(imageTitle)}"` : '';
        return `<img src="${escapeHtml(image.url)}" alt="${alt}"${dims}${titleAttr} loading="lazy" decoding="async">`;
      },
    },
  });
  // Wide tables scroll on their own instead of widening the page (phones).
  const html = (marked.parse(markdown) as string)
    .replace(/<table>/g, '<div class="guide-table"><table>')
    .replace(/<\/table>/g, '</table></div>');
  return { title, html };
}

/** `name-<hash>.ext` for an image: content-addressed, so it can be cached for good. */
export function guideImage(file: string): GuideImage {
  const bytes = readFileSync(file);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 10);
  const ext = extname(file).toLowerCase();
  const name =
    basename(file, extname(file))
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-') || 'image';
  const fileName = `${name}-${hash}${ext}`;
  return { file, url: `${guideImageBase}${fileName}`, fileName };
}

export function readManifest(guideDir: string): GuideManifest {
  const manifest = JSON.parse(readFileSync(resolve(guideDir, 'pages.json'), 'utf8')) as unknown;
  const pages = (manifest as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) throw new Error(`${guideDir}/pages.json: expected { pages: [] }`);
  for (const page of pages as GuidePageMeta[]) {
    if (!/^[a-z0-9-]+$/.test(page.slug) || typeof page.title?.en !== 'string') {
      throw new Error(`${guideDir}/pages.json: bad page entry ${JSON.stringify(page)}`);
    }
  }
  return { pages: pages as GuidePageMeta[] };
}

export interface BuildGuideOptions {
  guideDir: string;
  repoRoot: string;
  repoUrl?: string | undefined;
  locale: string;
  fallbackLocale?: string;
  warn?: (message: string) => void;
}

export interface BuiltGuide {
  pages: RenderedGuidePage[];
  images: GuideImage[];
  /** Every file the result depends on (for watch mode). */
  files: string[];
}

/** Every page of the guide in one locale, falling back per page to English. */
export function buildGuide(options: BuildGuideOptions): BuiltGuide {
  const { guideDir, repoRoot, repoUrl, locale, fallbackLocale = 'en' } = options;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const manifest = readManifest(guideDir);
  const slugs = new Set(manifest.pages.map((p) => p.slug));
  const images = new Map<string, GuideImage>();
  const files = [resolve(guideDir, 'pages.json')];
  const pages = manifest.pages.map((meta): RenderedGuidePage => {
    let lang = locale;
    let file = resolve(guideDir, locale, `${meta.slug}.md`);
    if (!existsSync(file)) {
      lang = fallbackLocale;
      file = resolve(guideDir, fallbackLocale, `${meta.slug}.md`);
    }
    if (!existsSync(file)) throw new Error(`guide: ${meta.slug}.md is missing`);
    files.push(file);
    const { html } = renderGuideMarkdown(readFileSync(file, 'utf8'), {
      file,
      guideDir,
      repoRoot,
      slugs,
      repoUrl,
      warn,
      image: (path) => {
        const image = images.get(path) ?? guideImage(path);
        images.set(path, image);
        files.push(path);
        return image;
      },
    });
    const title = meta.title[lang] ?? meta.title[fallbackLocale] ?? meta.slug;
    return { slug: meta.slug, title, lang, html };
  });
  checkAnchors(pages, warn);
  return { pages, images: [...images.values()], files };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Every `#anchor` a page links to (on itself or another page) must be a heading id there, the
 * way GitHub renders the same Markdown; a broken one is reported like a missing image.
 */
export function checkAnchors(
  pages: readonly RenderedGuidePage[],
  warn: (message: string) => void,
): void {
  const ids = new Map(
    pages.map((page) => [
      page.slug,
      new Set([...page.html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])),
    ]),
  );
  for (const page of pages) {
    for (const [, slug, fragment = ''] of page.html.matchAll(
      /href="(?:\/help\/([a-z0-9-]+))?#([^"]+)"/g,
    )) {
      const target = slug ?? page.slug;
      if (!ids.get(target)?.has(safeDecode(fragment))) {
        warn(`guide (${page.lang}) ${page.slug}: no heading #${fragment} on ${target}`);
      }
    }
  }
}

export const guideModulePrefix = 'virtual:rooster-guide/';

export interface GuidePluginOptions {
  guideDir: string;
  repoRoot: string;
  repoUrl?: string;
  locales: readonly string[];
}

/**
 * `virtual:rooster-guide/<locale>`: the guide as HTML, one lazy chunk per locale (precached
 * with the app's JS, so the text works offline). Screenshots go to `assets/guide/` and are
 * not precached; the service worker caches them when viewed (ADR 0052 §2).
 */
export function guidePlugin(options: GuidePluginOptions): Plugin {
  const served = new Map<string, string>();
  const emitted = new Set<string>();
  let isBuild = false;
  return {
    name: 'rooster-guide',
    enforce: 'pre',
    configResolved(config) {
      isBuild = config.command === 'build';
    },
    buildStart() {
      emitted.clear();
    },
    resolveId(id) {
      if (!id.startsWith(guideModulePrefix)) return null;
      const locale = id.slice(guideModulePrefix.length);
      if (!options.locales.includes(locale)) return null;
      return `\0${id}`;
    },
    load(id) {
      if (!id.startsWith(`\0${guideModulePrefix}`)) return null;
      const locale = id.slice(guideModulePrefix.length + 1);
      const guide = buildGuide({
        guideDir: options.guideDir,
        repoRoot: options.repoRoot,
        repoUrl: options.repoUrl,
        locale,
        warn: (message) => this.warn(message),
      });
      for (const file of guide.files) this.addWatchFile(file);
      for (const image of guide.images) {
        served.set(image.fileName, image.file);
        if (isBuild && !emitted.has(image.fileName)) {
          emitted.add(image.fileName);
          this.emitFile({
            type: 'asset',
            fileName: `assets/guide/${image.fileName}`,
            source: readFileSync(image.file),
          });
        }
      }
      return `export const pages = ${JSON.stringify(guide.pages)};\n`;
    },
    configureServer(server) {
      // Dev: serve the screenshots the loaded guide modules refer to.
      server.middlewares.use(guideImageBase, (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').replace(/^\//, '').split('?')[0] ?? '');
        const file = served.get(name);
        const type = file ? imageContentType(file) : undefined;
        if (!file || !type) return next();
        res.setHeader('Content-Type', type);
        res.end(readFileSync(file));
      });
    },
  };
}
