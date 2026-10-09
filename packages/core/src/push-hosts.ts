/**
 * The Web Push services a subscription endpoint may point at (04 §4.11: outbound requests go
 * only to known hosts). A browser hands us its endpoint, so without this any signed-in user
 * could make the server POST to an internal address (SSRF). Zod-free, for the web too.
 *
 * Each entry matches the host itself and its subdomains (WNS uses `*.notify.windows.com`).
 */
export const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge on Android, Opera
  'android.googleapis.com', // legacy GCM endpoints still handed out by older Chromium
  'updates.push.services.mozilla.com', // Firefox
  'push.services.mozilla.com',
  'web.push.apple.com', // Safari, iOS home-screen apps
  'notify.windows.com', // Edge on Windows (WNS)
] as const;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Whether `endpoint` is an https URL on the default port whose host is one of `hosts` (or a
 * subdomain). IP literals, credentials and explicit ports are rejected outright.
 */
export function isAllowedPushEndpoint(
  endpoint: string,
  hosts: readonly string[] = PUSH_SERVICE_HOSTS,
): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || IPV4.test(host)) return false;
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
