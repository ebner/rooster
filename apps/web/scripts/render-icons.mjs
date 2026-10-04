#!/usr/bin/env node
// Rasterises the app icons (03 §2.10) from public/icons/logo.svg with Playwright's
// Chromium. Run after changing the mark: `node scripts/render-icons.mjs`.
//   icon-192/512          coral rounded square, transparent corners, white mark at 60 %
//   maskable-512          full-bleed coral, white mark at 60 % (inside the 80 % safe zone)
//   apple-touch-icon-180  full-bleed coral (iOS applies its own mask), white mark at 60 %
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const iconsDir = fileURLToPath(new URL('../public/icons/', import.meta.url));
const coral500 = '#EF4F45';
const white = '#FFFFFF';
/** iOS-style corner radius as a share of the icon size. */
const roundedRadius = 0.2237;
const markScale = 0.6;

const logo = readFileSync(`${iconsDir}logo.svg`, 'utf8');
const markPath = logo.match(/<path[^>]* d="([^"]+)"/)?.[1];
if (!markPath) throw new Error('logo.svg: mark path not found');

const icons = [
  { file: 'icon-192.png', size: 192, rounded: true },
  { file: 'icon-512.png', size: 512, rounded: true },
  { file: 'maskable-512.png', size: 512, rounded: false },
  { file: 'apple-touch-icon-180.png', size: 180, rounded: false },
];

function iconSvg(size, rounded) {
  const radius = rounded ? size * roundedRadius : 0;
  const mark = size * markScale;
  const offset = (size - mark) / 2;
  const scale = mark / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${coral500}"/>
  <path transform="translate(${offset} ${offset}) scale(${scale})" fill="${white}" d="${markPath}"/>
</svg>`;
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { file, size, rounded } of icons) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${iconSvg(size, rounded)}</body></html>`,
    );
    await page.screenshot({ path: `${iconsDir}${file}`, omitBackground: rounded });
    process.stdout.write(`wrote public/icons/${file}\n`);
  }
} finally {
  await browser.close();
}
