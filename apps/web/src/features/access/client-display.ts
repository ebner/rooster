import type { OAuthClientInfo } from '@rooster/core/schemas';

/**
 * How an OAuth client's self-description is shown (11 §3.1, §7: consent phishing). Everything
 * here comes from the client (its metadata document or registration), so it is cleaned before
 * it reaches the screen: no control, bidi or zero-width characters (which can reorder or hide
 * text), whitespace collapsed, and a length cap so a name can't fill the page and push the
 * domain out of sight. React escapes the rest.
 */

/** Control (Cc), format (Cf: bidi overrides, zero-width joiners) and line separators. */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

export const CLIENT_NAME_MAX = 48;
const URI_MAX = 160;

/** Cleans client-supplied text and caps it at `max` characters (code points), with "…". */
export function cleanClientText(value: string, max = CLIENT_NAME_MAX): string {
  const cleaned = value.replace(/\s+/g, ' ').replace(UNSAFE_CHARS, '').trim();
  const chars = Array.from(cleaned);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : cleaned;
}

/**
 * The host as the browser would resolve it: internationalised names in punycode
 * (`xn--…`), so a look-alike domain can't pass for a familiar one.
 */
export function displayDomain(domain: string): string {
  const cleaned = cleanClientText(domain, 253).toLowerCase();
  try {
    const host = new URL(`https://${cleaned}`).hostname;
    return host || cleaned;
  } catch {
    return cleaned;
  }
}

/** A logo only over https (the CSP allows any https image); anything else gets the icon. */
export function httpsLogo(uri: string | null | undefined): string | null {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** "Verified" only for a metadata document whose host matches the redirect host (11 §3.1). */
export function isVerifiedClient(client: Pick<OAuthClientInfo, 'verified' | 'dynamic'>): boolean {
  return client.verified && !client.dynamic;
}

/** The client name to show; falls back to the domain when the name cleans to nothing. */
export function clientName(client: Pick<OAuthClientInfo, 'name' | 'domain'>): string {
  return cleanClientText(client.name) || displayDomain(client.domain);
}

/** The redirect target, cleaned and capped: shown so the user sees where the browser goes. */
export function displayRedirect(uri: string): string {
  return cleanClientText(uri, URI_MAX);
}

export type ResourceKind = 'mcp' | 'api' | 'other';

/** Which protected resource (RFC 8707) the token is for: `<base>/mcp` or `<base>/api/v1`. */
export function resourceKind(resource: string): ResourceKind {
  try {
    const path = new URL(resource).pathname.replace(/\/+$/, '');
    if (path === '/mcp') return 'mcp';
    if (path === '/api/v1') return 'api';
  } catch {
    // Not a URL: shown as given.
  }
  return 'other';
}

/** Schemes never navigated to, whatever the server or the client registered. */
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:']);

/**
 * Where to go after the decision. The server answers with the client's registered redirect
 * URI (with `code` and `iss`, or `error=access_denied`), which is by design another origin, so
 * it can't pass `safeRedirectPath`. It is followed only to the very target the screen showed
 * (`expected`, which the server validated):
 * - http(s): the same origin and path;
 * - a native app's private-use scheme (`com.example.app:/callback`, RFC 8252 §7.1): the same
 *   scheme, host and path.
 * `javascript:`, `data:`, `vbscript:`, `file:` and `blob:` are never followed.
 */
export function externalRedirect(redirectTo: string, expected: string): string | null {
  try {
    const url = new URL(redirectTo);
    const shown = new URL(expected);
    if (FORBIDDEN_SCHEMES.has(url.protocol) || url.protocol !== shown.protocol) return null;
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return url.origin === shown.origin && url.pathname === shown.pathname ? url.href : null;
    }
    return url.host === shown.host && url.pathname === shown.pathname ? url.href : null;
  } catch {
    return null;
  }
}

/** `ba_param`: the plugin's list of signed parameter names (better-auth `signed-query`). */
const SIGNED_NAMES_PARAM = 'ba_param';

/**
 * The provider's signed authorization query from the consent page's own URL. better-auth's
 * `consentPage` redirect appends the signed parameters (`client_id=…&sig=…`) to
 * `/oauth/consent`; this keeps exactly the signed ones, the same way the plugin's client does
 * (`buildSignedOAuthQuery`), so the server can verify the signature. Undefined without one.
 */
export function signedOAuthQuery(search: string): string | undefined {
  const params = new URLSearchParams(search);
  if (!params.has('sig')) return undefined;
  const names = new Set(params.getAll(SIGNED_NAMES_PARAM));
  if (names.size === 0) return undefined;
  const signed = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (key === 'sig' || key === SIGNED_NAMES_PARAM || names.has(key)) signed.append(key, value);
  }
  return signed.toString();
}
