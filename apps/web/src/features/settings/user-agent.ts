export type DeviceKind = 'desktop' | 'mobile' | 'tablet';

export interface DeviceDescription {
  browser: string | null;
  os: string | null;
  kind: DeviceKind;
}

const browsers: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Version\/[\d.]+.*Safari\//, 'Safari'],
  [/rooster-cli/i, 'rooster CLI'],
  [/curl\//, 'curl'],
];

const systems: [RegExp, string][] = [
  [/iPhone|iPod/, 'iOS'],
  [/iPad/, 'iPadOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
];

/**
 * A short, human description of a session's user agent ("Firefox on Windows").
 * Deliberately tiny: sessions only need a recognisable label, not full UA parsing.
 */
export function describeUserAgent(userAgent: string | null | undefined): DeviceDescription {
  const ua = userAgent ?? '';
  const browser = browsers.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const os = systems.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const kind: DeviceKind = /iPad|Tablet/.test(ua)
    ? 'tablet'
    : /Mobi|iPhone|Android/.test(ua)
      ? 'mobile'
      : 'desktop';
  return { browser, os, kind };
}
