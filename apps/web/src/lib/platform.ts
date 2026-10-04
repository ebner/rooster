export type Platform = 'mac' | 'other';

interface NavigatorLike {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

const applePlatform = /mac|iphone|ipad|ipod/i;

/** macOS and iOS show ⌘/⌥ glyphs; everything else spells out Ctrl/Alt (03 §3.14). */
export function detectPlatform(nav: NavigatorLike | undefined = globalThis.navigator): Platform {
  if (!nav) return 'other';
  const hint = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? '';
  return applePlatform.test(hint) ? 'mac' : 'other';
}
