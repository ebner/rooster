/**
 * The UI scale: the root font size over 16 px. Size tokens are rem, and theme.css raises the
 * root font size to 112.5 % from 1440 px, so layout constants measured
 * in px at scale 1 (the pane widths, D-29/D-29a) multiply by this to match what CSS renders.
 * It is 1 outside a browser and whenever the root font size cannot be read.
 */
export function uiScale(): number {
  try {
    const root = globalThis.document?.documentElement;
    if (!root || typeof getComputedStyle !== 'function') return 1;
    const size = Number.parseFloat(getComputedStyle(root).fontSize);
    return Number.isFinite(size) && size > 0 ? size / 16 : 1;
  } catch {
    return 1;
  }
}
