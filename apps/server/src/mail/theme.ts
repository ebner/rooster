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
    // The header logo is a picture (Fraunces is outlined in it); where images are blocked, its
    // alt text shows the name in a serif that keeps some of its character.
    wordmark: 'Georgia, "Times New Roman", serif',
  },
  size: fontSizes,
  space: spacing,
  radius: radii,
  /** The content column: wide enough for task titles, narrow enough for phones. */
  width: 560,
} as const;
