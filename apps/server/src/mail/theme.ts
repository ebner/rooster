// Coop tokens for email (03 §2): `@rooster/tokens` exists for non-CSS consumers like these.
import {
  fontFamilies,
  fontSizes,
  palette,
  radii,
  type SemanticColorToken,
  semanticColors,
  spacing,
} from '@rooster/tokens';

function color(token: SemanticColorToken): string {
  return palette[semanticColors[token]];
}

/** Resolved values, ready for inline styles (mail clients ignore CSS variables). */
export const mailTheme = {
  color: {
    page: color('bg-subtle'),
    card: color('bg-elevated'),
    text: color('text'),
    secondary: color('text-secondary'),
    muted: color('text-muted'),
    accent: color('text-accent'),
    onAccent: color('text-on-accent'),
    button: color('bg-accent'),
    border: color('border'),
    brand: color('brand'),
    danger: color('text-danger'),
    success: color('text-success'),
  },
  font: {
    sans: fontFamilies.sans,
    // The wordmark is set in Fraunces in the app; mail clients have no web fonts, and a
    // serif fallback keeps its character without an image (images are often blocked).
    wordmark: 'Georgia, "Times New Roman", serif',
  },
  size: fontSizes,
  space: spacing,
  radius: radii,
  /** The content column: wide enough for task titles, narrow enough for phones. */
  width: 560,
} as const;
