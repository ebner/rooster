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
//   apps/server/src/mail/logo.ts  mark + name as a 2x PNG for the emails' header (ADR 0059)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { palette, semanticColors } from '@rooster/tokens';
import {
  brandColors,
  markCentre,
  markGrid,
  markSvgBody,
  wordmarkPath,
  wordmarkViewBox,
} from '../src/ui/brand.ts';

const iconsDir = fileURLToPath(new URL('../public/icons/', import.meta.url));
const mailLogoFile = fileURLToPath(new URL('../../server/src/mail/logo.ts', import.meta.url));
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

const lockup = (ink) => `${markSvgBody({ ink, paint: brandColors.paint })}
  <path fill="${ink}" transform="translate(${markGrid + gap} ${(markGrid - nameHeight) / 2}) scale(${nameScale})" d="${wordmarkPath}"/>`;

const icons = [
  { file: 'icon-192.png', size: 192, rounded: true, mark: 0.66 },
  { file: 'icon-512.png', size: 512, rounded: true, mark: 0.66 },
  // Android masks to a circle (or squircle) inside the image: at 0.68 the farthest point of the
  // drawing is at 0.35 of the size from the centre, inside the 0.4 safe zone.
  { file: 'maskable-512.png', size: 512, rounded: false, mark: 0.68 },
  { file: 'apple-touch-icon-180.png', size: 180, rounded: false, mark: 0.66 },
];

function iconSvg({ size, rounded, mark }) {
  const radius = rounded ? size * roundedRadius : 0;
  const box = size * mark;
  const offset = (size - box) / 2;
  const scale = box / markGrid;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${brandColors.tile}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale}) ${markCentre}">${markSvgBody({ ink: brandColors.ink, paint: brandColors.paint })}</g>
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

  // The emails' header: mark + name 36 px tall, at 2x. Mail clients drop SVG and web fonts,
  // and a dark mode may darken a transparent background under the black line, so the picture
  // carries the email page's own background colour.
  const mailHeight = 36;
  const mailWidth = Math.round((lockupWidth * mailHeight) / markGrid);
  const mailPage = await browser.newPage({ deviceScaleFactor: 2 });
  await mailPage.setViewportSize({ width: mailWidth, height: mailHeight });
  await mailPage.setContent(
    `<html><body style="margin:0;background:${palette[semanticColors['bg-subtle']]}"><svg xmlns="http://www.w3.org/2000/svg" width="${mailWidth}" height="${mailHeight}" viewBox="0 0 ${lockupWidth} ${markGrid}" style="display:block">${lockup(brandColors.ink)}</svg></body></html>`,
  );
  const png = await mailPage.screenshot();
  writeFileSync(
    mailLogoFile,
    `// Generated by apps/web/scripts/render-icons.mjs from apps/web/src/ui/brand.ts; do not edit.\n` +
      `/** The emails' header logo: mark + name, a ${mailWidth * 2} × ${mailHeight * 2} PNG shown at ${mailWidth} × ${mailHeight}. */\n` +
      `export const mailLogo = {\n  width: ${mailWidth},\n  height: ${mailHeight},\n  png: '${png.toString('base64')}',\n} as const;\n`,
  );
  process.stdout.write('wrote apps/server/src/mail/logo.ts\n');
} finally {
  await browser.close();
}
