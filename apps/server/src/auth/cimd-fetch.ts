import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

/**
 * The transport for Client ID Metadata Documents and their `jwks_uri` (11 §4.2, ADR 0041 §6):
 * an IP-based SSRF guard, not the push host allowlist.
 * - https only, GET only, no credentials in the URL;
 * - the host is resolved **once**, and every answer must be a public unicast address
 *   (`isPublicAddress`): a name that resolves to one public and one private address is refused,
 *   so DNS rebinding between answers cannot reach the private one;
 * - the connection is pinned to the first approved address (the original host stays the TLS
 *   SNI, certificate identity and `Host`), so a second resolution can never be consulted;
 * - redirects are refused, the body is capped at `CIMD_MAX_BYTES` and the whole exchange at
 *   `CIMD_TIMEOUT_MS`. The CIMD plugin applies the same caps (5 KB, 5 s); these are ours, so the
 *   guard holds on its own.
 */

export const CIMD_MAX_BYTES = 5 * 1024;
export const CIMD_TIMEOUT_MS = 5_000;

type Lookup = (hostname: string) => Promise<readonly LookupAddress[]>;
type Connect = (
  url: URL,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

type PinnedCallback = (error: null, address: string | LookupAddress[], family?: number) => void;

export interface CimdFetchDeps {
  /** DNS resolution (all answers); tests inject answers. */
  lookup?: Lookup;
  /** `https.request`; tests inject a fake server. */
  connect?: Connect;
  timeoutMs?: number;
}

const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** 128-bit value of an IPv6 address (with optional embedded IPv4), or null. */
function ipv6Value(address: string): bigint | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted !== null) {
    const v4 = ipv4Value(dotted[1] as string);
    if (v4 === null) return null;
    text = `${text.slice(0, dotted.index)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : (halves[0] as string).split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? (halves[1] as string).split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

function ipv4Value(address: string): bigint | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = (value << 8n) | BigInt(Number(part));
  }
  return value;
}

const inPrefix = (value: bigint, base: bigint, bits: number, length: number) =>
  value >> BigInt(bits - length) === base >> BigInt(bits - length);

/** RFC 6890 special-purpose IPv4 blocks (none of them is a public unicast destination). */
const V4_BLOCKED: readonly [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata)
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
];

/** Inside 2000::/3 (global unicast), the special-purpose blocks. */
const V6_BLOCKED: readonly [string, number][] = [
  ['2001::', 23], // IETF protocol assignments, incl. Teredo (2001::/32)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an arbitrary IPv4)
  ['3fff::', 20], // documentation
];

function isPublicIpv4(value: bigint): boolean {
  return !V4_BLOCKED.some(([base, length]) =>
    inPrefix(value, ipv4Value(base) as bigint, 32, length),
  );
}

/**
 * Whether an IP literal is a public unicast address. IPv4-mapped (`::ffff:a.b.c.d`) and
 * IPv4-compatible forms are judged by their IPv4 address; for IPv6 only global unicast
 * (2000::/3) outside the special-purpose blocks counts, so loopback, unspecified, ULA
 * (fc00::/7), link-local, site-local, multicast and NAT64 are all refused.
 */
export function isPublicAddress(address: string): boolean {
  const literal = address.replace(/^\[|\]$/g, '');
  const family = isIP(literal.split('%')[0] as string);
  if (family === 4) {
    const v4 = ipv4Value(literal);
    return v4 !== null && isPublicIpv4(v4);
  }
  if (family !== 6) return false;
  const value = ipv6Value(literal);
  if (value === null) return false;
  // ::ffff:0:0/96 (mapped) and ::/96 (compatible, deprecated): judged as IPv4.
  if (value >> 32n === 0xffffn || value >> 32n === 0n) {
    const v4 = value & 0xffffffffn;
    return value >> 32n === 0xffffn && isPublicIpv4(v4);
  }
  if (!inPrefix(value, 0x2000n << 112n, 128, 3)) return false;
  return !V6_BLOCKED.some(([base, length]) =>
    inPrefix(value, ipv6Value(base) as bigint, 128, length),
  );
}

function headersOf(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.append(name, value);
  }
  return headers;
}

const timedOut = () => new TypeError('The client metadata fetch timed out.');

/** `work`, unless the deadline passes or `signal` aborts first (DNS cannot stall a request). */
function bounded<T>(work: Promise<T>, ms: number, signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      finish(() => reject(new TypeError('The client metadata fetch was aborted.')));
    const timer = setTimeout(() => finish(() => reject(timedOut())), ms);
    let done = false;
    function finish(settle: () => void) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle();
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** The guarded fetch (see the module comment). Rejects with a `TypeError` on every refusal. */
export function createCimdFetch(deps: CimdFetchDeps = {}) {
  const lookup = deps.lookup ?? defaultLookup;
  const connect: Connect = deps.connect ?? ((url, options, cb) => httpsRequest(url, options, cb));
  const timeoutMs = deps.timeoutMs ?? CIMD_TIMEOUT_MS;

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== 'https:')
      throw new TypeError('Client metadata must be fetched over https.');
    if (request.method !== 'GET') throw new TypeError('Client metadata is fetched with GET only.');
    if (url.username !== '' || url.password !== '') {
      throw new TypeError('Client metadata URLs must not carry credentials.');
    }
    // One deadline for the whole exchange, DNS included; an abort ends it at any point.
    const deadline = Date.now() + timeoutMs;
    const signal = init?.signal ?? undefined;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const literal = isIP(host);
    const answers: readonly LookupAddress[] =
      literal === 0
        ? await bounded(lookup(host), timeoutMs, signal)
        : [{ address: host, family: literal }];
    if (answers.length === 0) throw new TypeError('The client metadata host does not resolve.');
    if (!answers.every((a) => isPublicAddress(a.address))) {
      throw new TypeError('The client metadata host resolves to a non-public address.');
    }
    const pinned = answers[0] as LookupAddress;
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers) headers[name] = value;
    headers.host = url.host;

    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const req = connect(
        url,
        {
          method: 'GET',
          headers,
          agent: false,
          ...(literal === 0 ? { servername: host } : {}),
          ...(signal ? { signal } : {}),
          // Pinned: whatever name the socket asks for, it gets the address approved above.
          lookup: ((_hostname: string, options: { all?: boolean }, callback: PinnedCallback) => {
            if (options.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          }) as unknown as RequestOptions['lookup'],
        },
        (res) => {
          const status = res.statusCode ?? 502;
          // 304 answers a conditional revalidation (no body, cache headers): not a redirect.
          if (status >= 300 && status < 400 && status !== 304) {
            res.destroy();
            req.destroy();
            fail(new TypeError('Client metadata redirects are refused.'));
            return;
          }
          let received = 0;
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > CIMD_MAX_BYTES) {
              res.destroy(new TypeError('The client metadata document is too large.'));
            }
          });
          res.on('end', () => clearTimeout(timer));
          res.on('error', () => clearTimeout(timer));
          if (status < 200 || status > 599 || status === 204 || status === 205 || status === 304) {
            // No body to read (or not a usable status): the plugin answers anything but 200.
            // The connection goes now: a server that declares a body it never sends must not
            // hold the socket open once the deadline is no longer watching it.
            res.destroy();
            req.destroy();
            settled = true;
            clearTimeout(timer);
            resolve(
              status < 200 || status > 599
                ? new Response(null, { status: 502 })
                : new Response(null, { status, headers: headersOf(res) }),
            );
            return;
          }
          settled = true;
          resolve(
            new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
              status,
              headers: headersOf(res),
            }),
          );
        },
      );
      const timer = setTimeout(
        () => {
          const error = timedOut();
          req.destroy(error);
          fail(error);
        },
        Math.max(0, deadline - Date.now()),
      );
      req.once('error', fail);
      req.end();
    });
  };
}
