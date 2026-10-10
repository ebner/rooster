// A signed-in API client for scripts that drive a running rooster over HTTP (the RSS
// measurement in this folder and scripts/backup-drill.sh). It signs in through the mock OIDC
// issuer (apps/server/test/mock-idp.ts, as `pnpm dev:idp` runs it), picking the identity with
// `login_hint`, and keeps the cookies.

export class HttpSession {
  /**
   * @param {string} base the server's ROOSTER_BASE_URL, e.g. http://127.0.0.1:3190
   * @param {{ ip?: string }} options `ip`: sent as `X-Forwarded-For` (with
   *   ROOSTER_TRUST_PROXY=true), so each session has its own per-IP sign-in rate limit, as
   *   separate browsers would.
   */
  constructor(base, options = {}) {
    this.base = base.replace(/\/+$/, '');
    this.extra = options.ip === undefined ? {} : { 'x-forwarded-for': options.ip };
    /** @type {Map<string, string>} */
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** @param {Response} res */
  remember(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /** The OIDC sign-in a browser does: start, the issuer's authorize redirect, the callback. */
  async signIn(email, provider = 'dev') {
    const start = await fetch(`${this.base}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { ...this.extra, 'content-type': 'application/json', origin: this.base },
      body: JSON.stringify({
        provider,
        callbackURL: '/',
        errorCallbackURL: '/login',
        loginHint: email,
      }),
    });
    if (start.status !== 200)
      throw new Error(`sign-in start: ${start.status} ${await start.text()}`);
    this.remember(start);
    const { url } = await start.json();
    const authorize = await fetch(url, { redirect: 'manual' });
    const callback = authorize.headers.get('location');
    if (callback === null) throw new Error(`authorize: ${authorize.status} without a redirect`);
    const done = await fetch(callback, {
      redirect: 'manual',
      headers: { ...this.extra, cookie: this.cookieHeader() },
    });
    this.remember(done);
    const me = await this.call('GET', '/api/v1/me');
    if (me.status !== 200) throw new Error(`sign-in as ${email} failed: /me → ${me.status}`);
    return me.json();
  }

  /** An API request with the session cookie (and Origin, for the CSRF check). */
  call(method, path, body) {
    const headers = { ...this.extra, cookie: this.cookieHeader(), origin: this.base };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch(`${this.base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** Like `call`, but throws unless the status is `expected`; returns the parsed body. */
  async ok(method, path, body, expected = 200) {
    const res = await this.call(method, path, body);
    const text = await res.text();
    if (res.status !== expected) {
      throw new Error(`${method} ${path}: expected ${expected}, got ${res.status} ${text}`);
    }
    return text === '' ? undefined : JSON.parse(text);
  }
}

/** Polls `GET <base>/readyz` until it answers 200 or `timeoutMs` passes. */
export async function waitReady(base, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/readyz`);
      if (res.status === 200) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > until) throw new Error(`${base}/readyz not ready after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
