import { parse as legacyParse } from 'node:url';
import { isAllowedPushEndpoint } from '@rooster/core/push-hosts';

/**
 * The only form of an endpoint the push transport ever gets: the WHATWG serialisation, on an
 * allowed push service, that the legacy parser reads the same way. `web-push` connects with
 * `url.parse()`, which can read a raw string differently: `https://127.0.0.1%2efcm.googleapis.com/`
 * is `127.0.0.1.fcm.googleapis.com` to WHATWG but `127.0.0.1` to `url.parse()` (SSRF, 04
 * §4.11). Null when it does not parse, is not allowed, or the parsers disagree on host or port.
 */
export function canonicalPushEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const canonical = url.href;
  if (!isAllowedPushEndpoint(canonical)) return null;
  const legacy = legacyParse(canonical);
  if (legacy.hostname !== url.hostname || (legacy.port ?? '') !== url.port) return null;
  return canonical;
}
