/**
 * A same-origin path to return to after sign-in, or undefined. Resolving against the
 * current origin and comparing origins rejects protocol-relative (`//evil.example`),
 * backslash (`/\evil.example`), absolute and `javascript:` targets (open redirects).
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
  return url.pathname + url.search + url.hash;
}
