#!/usr/bin/env node
// Writes every static brand file (03 §2.10, ADR 0026) from src/ui/brand.ts, so the icons,
// the favicon and the in-app logo are one drawing. Run after changing the mark:
// `node scripts/render-icons.mjs` (Node imports the .ts module directly).
//   favicon.svg           small cut, ink line (white in a dark browser theme), amber paint
//   logo.svg / wordmark.svg  the mark, and mark + name, for docs and the README
//   wordmark-dark.svg     mark + name with a white line, for the README in dark themes
//   logo-stack.svg        mark above name: the loading screen in index.html
//   icon-192/512          ink rounded square, transparent corners, white line, amber paint
//   maskable-512          full-bleed ink, the mark inside the 80 % safe zone
//   apple-touch-icon-180  full-bleed ink (iOS applies its own mask)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  brandColors,
  markCentre,
  markGrid,
  markSvgBody,
  wordmarkPath,
  wordmarkViewBox,
} from '../src/ui/brand.ts';

const iconsDir = fileURLToPath(new URL('../public/icons/', import.meta.url));
/** iOS-style corner radius as a share of the icon size. */
const roundedRadius = 0.2237;

const write = (file, text) => {
  writeFileSync(`${iconsDir}${file}`, text);
  process.stdout.write(`wrote public/icons/${file}\n`);
};

// The favicon switches its line colour with the browser theme (tabs can be dark).
write(
  'favicon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${markGrid} ${markGrid}" width="32" height="32">
  <title>rooster</title>
  <style>svg{color:${brandColors.ink}}@media (prefers-color-scheme:dark){svg{color:${brandColors.inkInverse}}}</style>
  ${markSvgBody({ small: true, ink: 'currentColor', paint: brandColors.paint })}
</svg>
`,
);

write(
  'logo.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${markGrid} ${markGrid}" width="48" height="48">
  <title>rooster</title>
  ${markSvgBody({ ink: brandColors.ink, paint: brandColors.paint })}
</svg>
`,
);

// Mark at 48, name at 0.48 of it, as the `row` Logo lays them out.
const nameHeight = markGrid * 0.48;
const nameScale = nameHeight / wordmarkViewBox.height;
const nameWidth = wordmarkViewBox.width * nameScale;
const gap = 6 * 2;
const lockupWidth = Math.ceil(markGrid + gap + nameWidth);
// The README shows the dark variant (white line and name) under GitHub's dark theme.
for (const [file, ink] of [
  ['wordmark.svg', brandColors.ink],
  ['wordmark-dark.svg', brandColors.inkInverse],
]) {
  write(
    file,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lockupWidth} ${markGrid}" width="${lockupWidth}" height="${markGrid}" role="img" aria-label="rooster">
  ${markSvgBody({ ink, paint: brandColors.paint })}
  <path fill="${ink}" transform="translate(${markGrid + gap} ${(markGrid - nameHeight) / 2}) scale(${nameScale})" d="${wordmarkPath}"/>
</svg>
`,
  );
}

// Mark above the name, as the `stack` Logo lays them out (name at 0.36 of the mark).
const stackName = markGrid * 0.36;
const stackScale = stackName / wordmarkViewBox.height;
const stackNameWidth = wordmarkViewBox.width * stackScale;
const stackGap = 8 * (markGrid / 64);
const stackWidth = Math.ceil(Math.max(markGrid, stackNameWidth));
const stackHeight = Math.ceil(markGrid + stackGap + stackName);
write(
  'logo-stack.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${stackWidth} ${stackHeight}" width="${stackWidth}" height="${stackHeight}" role="img" aria-label="rooster">
  <g transform="translate(${(stackWidth - markGrid) / 2} 0)">${markSvgBody({ ink: brandColors.ink, paint: brandColors.paint })}</g>
  <path fill="${brandColors.ink}" transform="translate(${(stackWidth - stackNameWidth) / 2} ${markGrid + stackGap}) scale(${stackScale})" d="${wordmarkPath}"/>
</svg>
`,
);

const icons = [
  { file: 'icon-192.png', size: 192, rounded: true, mark: 0.66 },
  { file: 'icon-512.png', size: 512, rounded: true, mark: 0.66 },
  { file: 'maskable-512.png', size: 512, rounded: false, mark: 0.56 },
  { file: 'apple-touch-icon-180.png', size: 180, rounded: false, mark: 0.66 },
];

function iconSvg({ size, rounded, mark }) {
  const radius = rounded ? size * roundedRadius : 0;
  const box = size * mark;
  const offset = (size - box) / 2;
  const scale = box / markGrid;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${brandColors.tile}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale}) ${markCentre}">${markSvgBody({ ink: brandColors.inkInverse, paint: brandColors.paint })}</g>
</svg>`;
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const icon of icons) {
    await page.setViewportSize({ width: icon.size, height: icon.size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${iconSvg(icon)}</body></html>`,
    );
    await page.screenshot({ path: `${iconsDir}${icon.file}`, omitBackground: icon.rounded });
    process.stdout.write(`wrote public/icons/${icon.file}\n`);
  }
} finally {
  await browser.close();
}
