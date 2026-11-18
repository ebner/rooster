/**
 * Builds the project site into apps/site/dist (ADR 0070):
 *   1. the browser script and stylesheet with Vite (hashed, under assets/);
 *   2. the screenshots from docs/screenshots as responsive WebP (img/);
 *   3. the landing page and the user guide in English (/) and Swedish (/sv/), from the app's
 *      own guide renderer;
 *   4. the icons, the Open Graph image, 404.html, the sitemap and the third-party notices;
 *   5. a check that every internal link and image resolves to a built file.
 *
 * SITE_URL (default https://ebner.github.io/rooster/) sets the address; its path is the base.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { build } from 'vite';
import { buildGuide, pngInfo } from '../../web/src/features/help/guide-build.ts';
import {
  brandColors,
  markGrid,
  markSvgBody,
  wordmarkPath,
  wordmarkViewBox,
} from '../../web/src/ui/brand.ts';
import {
  copyFor,
  type ImageSet,
  type Lang,
  langPrefix,
  languages,
  repoUrl,
  type SiteContext,
  siteUrl,
} from '../src/config.ts';
import { guideIndexPage, guidePage } from '../src/guide.ts';
import { html } from '../src/html.ts';
import { landingPage } from '../src/landing.ts';
import { layout, link, type Page } from '../src/layout.ts';
import { brokenLinks } from '../src/link-check.ts';

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(siteDir, '../..');
const dist = resolve(siteDir, 'dist');
const screenshots = resolve(repoRoot, 'docs/screenshots');
const guideDir = resolve(repoRoot, 'docs/guide');
const icons = resolve(repoRoot, 'apps/web/public/icons');

const url = siteUrl();
const base = url.pathname;
const version = (
  JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { version: string }
).version;

const warnings: string[] = [];
const warn = (message: string) => warnings.push(message);

const write = (path: string, content: string | Buffer) => {
  const file = join(dist, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};

const hash = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 10);

// 1. Script and stylesheet.
rmSync(dist, { recursive: true, force: true });
await build({
  configFile: false,
  root: siteDir,
  base,
  logLevel: 'warn',
  build: {
    outDir: dist,
    emptyOutDir: false,
    manifest: 'manifest.json',
    target: 'es2023',
    rollupOptions: { input: resolve(siteDir, 'src/client/main.ts') },
  },
});
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')) as Record<
  string,
  { file: string; css?: string[] }
>;
const entry = manifest['src/client/main.ts'];
if (!entry) throw new Error('site: the client entry is missing from the Vite manifest');
rmSync(join(dist, 'manifest.json'));

// 2. Screenshots: <name>.<device>.light.png → img/<name>.<device>-<width>-<hash>.webp.
/**
 * Feature sections show the part of a screen that matters, so its text stays readable: crops
 * in CSS px of the screenshot's window (docs/screenshots record their density).
 */
const crops: Record<string, { left: number; top: number; width: number; height: number }> = {
  'palette.desktop': { left: 290, top: 0, width: 1130, height: 560 },
  'project-view.desktop': { left: 280, top: 0, width: 1140, height: 600 },
  'inbox.desktop': { left: 280, top: 0, width: 1140, height: 640 },
  'device-consent.desktop': { left: 400, top: 40, width: 640, height: 820 },
  'date-picker.desktop': { left: 715, top: 56, width: 397, height: 870 },
};
const images = new Map<string, ImageSet>();
await Promise.all(
  readdirSync(screenshots)
    .filter((f) => f.endsWith('.light.png'))
    .map(async (file) => {
      const name = file.replace(/\.light\.png$/, '');
      const source = readFileSync(join(screenshots, file));
      const original = pngInfo(source);
      if (!original) throw new Error(`site: ${file} is not a PNG`);
      const crop = crops[name];
      const bytes = crop
        ? await sharp(source)
            .extract({
              left: Math.round(crop.left * original.scale),
              top: Math.round(crop.top * original.scale),
              width: Math.round(crop.width * original.scale),
              height: Math.round(crop.height * original.scale),
            })
            .png()
            .toBuffer()
        : source;
      const info = crop
        ? {
            ...original,
            width: Math.round(crop.width * original.scale),
            height: Math.round(crop.height * original.scale),
          }
        : original;
      const cssWidth = Math.round(info.width / info.scale);
      const cssHeight = Math.round(info.height / info.scale);
      const widths = [
        ...new Set([Math.min(info.width, 960), Math.min(info.width, 1600), info.width]),
      ]
        .filter((w) => w >= Math.min(info.width, cssWidth / 2))
        .sort((a, b) => a - b);
      const sources: { url: string; width: number }[] = [];
      for (const width of widths) {
        const webp = await sharp(bytes)
          .resize({ width })
          .webp({ quality: 82, effort: 5 })
          .toBuffer();
        const out = `img/${name}-${width}-${hash(webp)}.webp`;
        write(out, webp);
        sources.push({ url: link({ base }, out), width });
      }
      const largest = sources.at(-1);
      if (!largest) throw new Error(`site: no sizes for ${file}`);
      images.set(name, {
        src: largest.url,
        srcset: sources.map((s) => `${s.url} ${s.width}w`).join(', '),
        width: cssWidth,
        height: cssHeight,
      });
    }),
);

// 3. Pages.
const englishGuide = buildGuide({ guideDir, repoRoot, repoUrl, locale: 'en', warn });
const guideManifest = JSON.parse(readFileSync(join(guideDir, 'pages.json'), 'utf8')) as {
  pages: { slug: string; title: Record<string, string> }[];
};

const site: SiteContext = {
  url,
  base,
  version,
  css: (entry.css ?? []).map((f) => link({ base }, f)),
  js: link({ base }, entry.file),
  images,
  guidePages: guideManifest.pages,
};

/** The first paragraph's text, for the description meta tag. */
function summary(rendered: string): string {
  const paragraph = /<p>([\s\S]*?)<\/p>/.exec(rendered)?.[1] ?? '';
  const text = paragraph
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 180 ? `${text.slice(0, 177).replace(/\s+\S*$/, '')} …` : text;
}

const pages: Page[] = [];
const guideImages = new Map(englishGuide.images.map((i) => [i.fileName, i.file]));
for (const lang of languages) {
  pages.push(landingPage(site, lang));
  pages.push(guideIndexPage(site, lang));
  const guide =
    lang === 'en' ? englishGuide : buildGuide({ guideDir, repoRoot, repoUrl, locale: lang, warn });
  for (const image of guide.images) guideImages.set(image.fileName, image.file);
  guide.pages.forEach((page, i) => {
    pages.push(guidePage(site, lang, page, i, summary(page.html)));
  });
}
for (const [fileName, file] of guideImages) write(`assets/guide/${fileName}`, readFileSync(file));

for (const page of pages) write(`${page.path}index.html`, layout(site, page));

const notFound = (lang: Lang): Page => {
  const copy = copyFor[lang].notFound;
  return {
    path: '404.html',
    lang,
    alternate: null,
    title: `${copy.title} · rooster`,
    description: copy.body,
    noindex: true,
    body: html`<div class="wrap not-found"><h1>${copy.title}</h1><p>${copy.body}</p><a class="button primary" href="${link(site, langPrefix(lang))}">${copy.home}</a></div>`,
  };
};
write('404.html', layout(site, notFound('en')));

// 4. Icons, the Open Graph image, sitemap, robots, notices.
copyFileSync(join(icons, 'favicon.svg'), join(dist, 'favicon.svg'));
copyFileSync(join(icons, 'apple-touch-icon-180.png'), join(dist, 'apple-touch-icon.png'));
copyFileSync(resolve(repoRoot, 'THIRD-PARTY-NOTICES.txt'), join(dist, 'third-party-notices.txt'));
write('.nojekyll', '');
write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${new URL('sitemap.xml', url).href}\n`);
write(
  'sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
    .filter((p) => !p.noindex)
    .map((p) => `  <url><loc>${new URL(p.path, url).href}</loc></url>`)
    .join('\n')}\n</urlset>\n`,
);
if (process.env.SITE_CNAME) write('CNAME', `${process.env.SITE_CNAME}\n`);

/** 1200 × 630: the logo on the app icons' cream, the task list running off the edge. */
async function ogImage(): Promise<Buffer> {
  const width = 1200;
  const height = 630;
  const markSize = 120;
  const nameHeight = markSize * 0.45;
  const nameWidth = (wordmarkViewBox.width / wordmarkViewBox.height) * nameHeight;
  const logo = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${markSize + 10 + nameWidth}" height="${markSize}">` +
      `<svg width="${markSize}" height="${markSize}" viewBox="0 0 ${markGrid} ${markGrid}">${markSvgBody({ ink: brandColors.ink, paint: brandColors.paint })}</svg>` +
      `<svg x="${markSize + 10}" y="${(markSize - nameHeight) / 2 + nameHeight * 0.12}" width="${nameWidth}" height="${nameHeight}" viewBox="0 0 ${wordmarkViewBox.width} ${wordmarkViewBox.height}"><path fill="${brandColors.ink}" d="${wordmarkPath}"/></svg>` +
      '</svg>',
  );
  const shotWidth = 900;
  const shotFile = join(screenshots, 'my-tasks.desktop.light.png');
  const shot = await sharp(shotFile).resize({ width: shotWidth }).png().toBuffer();
  const shotHeight = height - 230 + 40;
  const rounded = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${shotWidth}" height="${shotHeight}"><rect width="${shotWidth}" height="${shotHeight + 40}" rx="18" fill="#fff"/></svg>`,
  );
  const shotCropped = await sharp(shot)
    .extract({ left: 0, top: 0, width: shotWidth, height: shotHeight })
    .composite([{ input: rounded, blend: 'dest-in' }])
    .png()
    .toBuffer();
  const border = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${shotWidth + 2}" height="${shotHeight + 2}"><rect x="0.5" y="0.5" width="${shotWidth + 1}" height="${shotHeight + 40}" rx="18.5" fill="none" stroke="#E2E5EA"/></svg>`,
  );
  return sharp({ create: { width, height, channels: 4, background: brandColors.tile } })
    .composite([
      { input: logo, left: 80, top: 56 },
      { input: shotCropped, left: 240, top: 230 },
      { input: border, left: 239, top: 229 },
    ])
    .png({ palette: true, quality: 90 })
    .toBuffer();
}
write('og.png', await ogImage());

function* htmlFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name.endsWith('.html')) yield path;
  }
}

// Screenshots no page shows aren't published.
const allHtml = [...htmlFiles(dist)].map((file) => readFileSync(file, 'utf8')).join('\n');
for (const file of readdirSync(join(dist, 'img'))) {
  if (!allHtml.includes(`img/${file}`)) rmSync(join(dist, 'img', file));
}

// 5. Every internal link and image resolves to a built file.
const broken: string[] = [];
for (const file of htmlFiles(dist)) {
  const page = relative(dist, file)
    .split(sep)
    .join('/')
    .replace(/index\.html$/, '');
  const found = brokenLinks(
    readFileSync(file, 'utf8'),
    new URL(page, url),
    url,
    (path) => existsSync(join(dist, path)) && statSync(join(dist, path)).isFile(),
  );
  for (const target of found) broken.push(`${relative(dist, file)}: ${target}`);
}
for (const w of warnings) console.warn(`warning: ${w}`);
if (broken.length > 0 || warnings.length > 0) {
  for (const b of broken) console.error(`broken link: ${b}`);
  process.exit(1);
}
console.log(
  `site: ${pages.length} pages, ${readdirSync(join(dist, 'img')).length} images → ${relative(repoRoot, dist)} (${url.href})`,
);
