// WP 9.3, 11 §4.2, ADR 0041 §6: the SSRF guard for Client ID Metadata Documents.
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CIMD_MAX_BYTES, createCimdFetch, isPublicAddress } from '../src/auth/cimd-fetch.ts';
import { BASE_URL } from './helpers.ts';
import { authorizeUrl, metadataDoc, oauthCtx, pkce } from './oauth-helpers.ts';

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.1',
    '198.18.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe',
    '::127.0.0.1',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd12:3456::1',
    'fec0::1',
    'ff02::1',
    '64:ff9b::a00:1',
    '64:ff9b::8.8.8.8',
    '2002:7f00:1::1',
    '2001:0:4136:e378::1',
    '2001:db8::1',
    '[::1]',
    'localhost',
    'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.32.0.1',
    '::ffff:8.8.8.8',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
  ])('allows %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

interface FakeServer {
  status?: number;
  headers?: Record<string, string>;
  /** Body chunks; `null` leaves the response open (a slow server). */
  chunks?: (string | null)[];
}

/** A fake `https.request` that records the options and answers like `server`. */
function fakeConnect(server: FakeServer = {}) {
  const calls: { url: URL; options: RequestOptions }[] = [];
  const connect = (url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    calls.push({ url, options });
    const req = new EventEmitter() as ClientRequest & EventEmitter;
    const res = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(res, {
      statusCode: server.status ?? 200,
      headers: server.headers ?? { 'content-type': 'application/json' },
    });
    req.destroy = ((error?: Error) => {
      res.destroy(error);
      return req;
    }) as ClientRequest['destroy'];
    req.end = (() => {
      queueMicrotask(() => {
        callback(res);
        for (const chunk of server.chunks ?? ['{}']) {
          if (chunk === null) return;
          res.write(chunk);
        }
        res.end();
      });
      return req;
    }) as ClientRequest['end'];
    return req;
  };
  return { connect, calls };
}

const lookupOf =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('createCimdFetch (11 §4.2)', () => {
  it('refuses http, other methods and credentials in the URL', async () => {
    const { connect, calls } = fakeConnect();
    const fetch = createCimdFetch({ lookup: lookupOf('8.8.8.8'), connect });
    await expect(fetch('http://app.example.com/client.json')).rejects.toThrow(/https/);
    await expect(
      fetch('https://app.example.com/client.json', { method: 'POST', body: '{}' }),
    ).rejects.toThrow(/GET/);
    await expect(fetch('https://u:p@app.example.com/client.json')).rejects.toThrow(/credentials/);
    expect(calls).toEqual([]);
  });

  it('refuses a host that resolves to a private, loopback or link-local address', async () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::1', 'fd00::1']) {
      const { connect, calls } = fakeConnect();
      const fetch = createCimdFetch({ lookup: lookupOf(address), connect });
      await expect(fetch('https://app.example.com/client.json')).rejects.toThrow(/non-public/);
      expect(calls).toEqual([]);
    }
  });

  it('refuses a name with any non-public answer among public ones (DNS rebinding)', async () => {
    const { connect, calls } = fakeConnect();
    const fetch = createCimdFetch({ lookup: lookupOf('8.8.8.8', '127.0.0.1'), connect });
    await expect(fetch('https://app.example.com/client.json')).rejects.toThrow(/non-public/);
    expect(calls).toEqual([]);
  });

  it('refuses IP literals that are not public, and a name without answers', async () => {
    const { connect, calls } = fakeConnect();
    const fetch = createCimdFetch({ lookup: lookupOf(), connect });
    await expect(fetch('https://127.0.0.1/client.json')).rejects.toThrow(/non-public/);
    await expect(fetch('https://[::ffff:127.0.0.1]/client.json')).rejects.toThrow(/non-public/);
    await expect(fetch('https://app.example.com/client.json')).rejects.toThrow(/does not resolve/);
    expect(calls).toEqual([]);
  });

  it('pins the connection to the approved address, keeping the name for TLS and Host', async () => {
    const { connect, calls } = fakeConnect({ chunks: ['{"ok":true}'] });
    let lookups = 0;
    const fetch = createCimdFetch({
      lookup: async () => {
        lookups += 1;
        return [{ address: '93.184.216.34', family: 4 }];
      },
      connect,
    });
    const res = await fetch('https://app.example.com/client.json', {
      headers: { accept: 'application/json' },
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(lookups).toBe(1);
    const options = calls[0]?.options;
    expect((options as { servername?: string } | undefined)?.servername).toBe('app.example.com');
    expect((options?.headers as Record<string, string> | undefined)?.host).toBe('app.example.com');
    // Whatever the socket asks for, it gets the approved address, never a fresh resolution.
    const lookup = options?.lookup as unknown as (
      host: string,
      opts: { all?: boolean },
      cb: (...args: unknown[]) => void,
    ) => void;
    const answers: unknown[][] = [];
    lookup('evil.example', {}, (...args) => answers.push(args));
    lookup('evil.example', { all: true }, (...args) => answers.push(args));
    expect(answers).toEqual([
      [null, '93.184.216.34', 4],
      [null, [{ address: '93.184.216.34', family: 4 }]],
    ]);
    expect(lookups).toBe(1);
  });

  it('refuses redirects', async () => {
    const { connect } = fakeConnect({
      status: 302,
      headers: { location: 'https://169.254.169.254/latest/meta-data' },
    });
    const fetch = createCimdFetch({ lookup: lookupOf('8.8.8.8'), connect });
    await expect(fetch('https://app.example.com/client.json')).rejects.toThrow(/redirect/);
  });

  it(`caps the body at ${CIMD_MAX_BYTES} bytes`, async () => {
    const { connect } = fakeConnect({ chunks: ['x'.repeat(CIMD_MAX_BYTES), 'xx'] });
    const fetch = createCimdFetch({ lookup: lookupOf('8.8.8.8'), connect });
    const res = await fetch('https://app.example.com/client.json');
    await expect(res.text()).rejects.toThrow();
  });

  it('times out a slow server', async () => {
    const slow = fakeConnect({ chunks: [null] });
    const fetch = createCimdFetch({
      lookup: lookupOf('8.8.8.8'),
      connect: slow.connect,
      timeoutMs: 50,
    });
    const res = await fetch('https://app.example.com/client.json');
    await expect(res.text()).rejects.toThrow();
    // A server that never answers at all.
    const silent = createCimdFetch({
      lookup: lookupOf('8.8.8.8'),
      connect: () => {
        const req = new EventEmitter() as ClientRequest & EventEmitter;
        req.end = (() => req) as ClientRequest['end'];
        req.destroy = ((error?: Error) => {
          req.emit('error', error);
          return req;
        }) as ClientRequest['destroy'];
        return req;
      },
      timeoutMs: 50,
    });
    await expect(silent('https://app.example.com/client.json')).rejects.toThrow(/timed out/);
  });
});

describe('CIMD through the provider (11 §4.2)', () => {
  const clientId = 'https://agent.example.org/client.json';

  /**
   * Authorizes with a client whose metadata the given transport serves: the consent page, or
   * the provider's error (`400 invalid_client`: an unresolvable client gets no redirect).
   */
  async function attempt(fetch: (input: string | URL | Request) => Promise<Response>) {
    const ctx = oauthCtx({ cimd: { fetch, fetched: [], docs: {} } });
    const user = ctx.user('ada@example.com');
    const res = await ctx.app.request(
      authorizeUrl(
        { clientId, redirectUri: 'https://agent.example.org/callback' },
        pkce().challenge,
      ),
      { headers: { cookie: user.jar.header() } },
    );
    const location = res.headers.get('location');
    if (location !== null)
      return { consent: new URL(location, BASE_URL).pathname === '/oauth/consent', error: null };
    return { consent: false, error: ((await res.json()) as { error?: string }).error ?? null };
  }

  it('refuses a client whose metadata host resolves privately (the guard is the transport)', async () => {
    const { connect, calls } = fakeConnect({ chunks: [JSON.stringify(metadataDoc(clientId))] });
    const page = await attempt(createCimdFetch({ lookup: lookupOf('10.0.0.7'), connect }));
    expect(page).toEqual({ consent: false, error: 'invalid_client' });
    expect(calls).toEqual([]);
  });

  it('refuses redirects and oversized documents', async () => {
    const redirect = fakeConnect({ status: 301, headers: { location: 'https://x.example/' } });
    const viaRedirect = await attempt(
      createCimdFetch({ lookup: lookupOf('8.8.8.8'), connect: redirect.connect }),
    );
    expect(viaRedirect).toEqual({ consent: false, error: 'invalid_client' });
    const big = { ...metadataDoc(clientId), padding: 'x'.repeat(CIMD_MAX_BYTES) };
    const oversized = fakeConnect({ chunks: [JSON.stringify(big)] });
    const viaBig = await attempt(
      createCimdFetch({ lookup: lookupOf('8.8.8.8'), connect: oversized.connect }),
    );
    expect(viaBig).toEqual({ consent: false, error: 'invalid_client' });
  });

  it('accepts a public, well-formed document', async () => {
    const ok = fakeConnect({ chunks: [JSON.stringify(metadataDoc(clientId))] });
    const page = await attempt(
      createCimdFetch({ lookup: lookupOf('8.8.8.8'), connect: ok.connect }),
    );
    expect(page).toEqual({ consent: true, error: null });
  });
});
