import {
  markEye,
  markEyeRadius,
  markGrid,
  markLine,
  markPaint,
  markStroke,
  wordmarkPath,
  wordmarkViewBox,
} from '../../web/src/ui/brand.ts';
import { raw, type SafeHtml } from './html.ts';

/**
 * The rooster mark and wordmark as inline SVG, drawn from the app's single source
 * (`apps/web/src/ui/brand.ts`, 03 §2.10). `animated` draws the line and brushes the comb in,
 * the same sequence as the app's sign-in screen (site.css `.rooster-mark[data-drawing]`).
 */
export function markSvg(options: { size: number; animated?: boolean; id: string }): SafeHtml {
  const { size, animated = false, id } = options;
  const paint = markPaint
    .map((area, i) => {
      if (!animated) return `<path class="paint" transform="${area.transform}" d="${area.d}"/>`;
      const mask = `${id}-paint-${i}`;
      return (
        `<mask id="${mask}" maskUnits="userSpaceOnUse" x="-4" y="-4" width="${markGrid + 8}" height="${markGrid + 8}">` +
        `<path class="brush" data-step="${i}" pathLength="1" stroke-width="${area.brushWidth}" transform="${area.transform}" d="${area.brush}"/>` +
        `</mask><path class="paint" mask="url(#${mask})" transform="${area.transform}" d="${area.d}"/>`
      );
    })
    .join('');
  return raw(
    `<svg class="rooster-mark" viewBox="0 0 ${markGrid} ${markGrid}" width="${size}" height="${size}" aria-hidden="true"${animated ? ' data-drawing' : ''}>` +
      paint +
      `<path class="ink" pathLength="1" stroke-width="${markStroke.regular}" d="${markLine}"/>` +
      `<circle class="eye" cx="${markEye.cx}" cy="${markEye.cy}" r="${markEyeRadius.regular}"/>` +
      '</svg>',
  );
}

export function wordmarkSvg(height: number): SafeHtml {
  const width = Math.round((wordmarkViewBox.width / wordmarkViewBox.height) * height * 10) / 10;
  return raw(
    `<svg class="rooster-wordmark" viewBox="0 0 ${wordmarkViewBox.width} ${wordmarkViewBox.height}" width="${width}" height="${height}" aria-hidden="true">` +
      `<path fill="currentColor" d="${wordmarkPath}"/></svg>`,
  );
}
