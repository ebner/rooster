/**
 * A same-origin path to return to after sign-in, or undefined. Resolving against the
 * current origin and comparing origins rejects protocol-relative (`//evil.example`),
 * backslash (`/\evil.example`), absolute and `javascript:` targets (open redirects).
 * The result is checked again: dot segments normalise (`/.//evil.example` → `//evil.example`), and a
 * path starting with `//` or holding a backslash would leave the origin once navigated to.
 */
export function safeRedirectPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const origin = globalThis.location?.origin;
  if (!origin) return undefined;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return undefined;
  }
  if (url.origin !== origin) return undefined;
  const path = url.pathname + url.search + url.hash;
  if (path.startsWith('//') || path.includes('\\')) return undefined;
  return path;
}
