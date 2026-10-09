import { describe, expect, it } from 'vitest';
import {
  createRoosterClient,
  isProblem,
  type Problem,
  RoosterApiError,
  unwrap,
} from '../src/index.ts';

const problem: Problem = {
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  detail: 'This token cannot write tasks.',
  code: 'forbidden_scope',
};

/** A fetch that records each request and answers with `respond`. */
function fakeFetch(respond: (req: Request) => Response) {
  const requests: Request[] = [];
  const fetch = async (input: Request) => {
    requests.push(input);
    return respond(input);
  };
  return { requests, fetch: fetch as unknown as typeof globalThis.fetch };
}

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } });

describe('createRoosterClient', () => {
  it('sends a static bearer token and the client headers', async () => {
    const f = fakeFetch(() => json({ ok: true }));
    const api = createRoosterClient({
      baseUrl: 'https://tasks.example.com',
      token: 'rooster_pat_abc',
      clientName: 'cli/1.2.0',
      clientId: 'proc-1',
      fetch: f.fetch,
    });
    await api.GET('/api/v1/me');
    const req = f.requests[0];
    expect(req?.url).toBe('https://tasks.example.com/api/v1/me');
    expect(req?.headers.get('authorization')).toBe('Bearer rooster_pat_abc');
    expect(req?.headers.get('x-rooster-client')).toBe('cli/1.2.0');
    expect(req?.headers.get('x-rooster-client-id')).toBe('proc-1');
  });

  it('asks a token function on every request and sends nothing for undefined', async () => {
    const f = fakeFetch(() => json({}));
    let token: string | undefined = 'first';
    const api = createRoosterClient({
      baseUrl: 'http://x',
      token: async () => token,
      fetch: f.fetch,
    });
    await api.GET('/api/v1/me');
    token = undefined;
    await api.GET('/api/v1/me');
    expect(f.requests[0]?.headers.get('authorization')).toBe('Bearer first');
    expect(f.requests[1]?.headers.has('authorization')).toBe(false);
  });

  it('sends no Authorization header in cookie mode', async () => {
    const f = fakeFetch(() => json({}));
    await createRoosterClient({ baseUrl: 'http://x', fetch: f.fetch }).GET('/api/v1/me');
    expect(f.requests[0]?.headers.has('authorization')).toBe(false);
  });
});

describe('isProblem', () => {
  it('accepts a problem document and rejects anything else', () => {
    expect(isProblem(problem)).toBe(true);
    expect(isProblem({ ...problem, code: '' })).toBe(false);
    expect(isProblem({ code: 'x' })).toBe(false);
    expect(isProblem(null)).toBe(false);
    expect(isProblem('forbidden_scope')).toBe(false);
  });
});

describe('unwrap', () => {
  it('returns the data of a 2xx response', async () => {
    const f = fakeFetch(() => json({ id: 'me' }));
    const api = createRoosterClient({ baseUrl: 'http://x', fetch: f.fetch });
    await expect(unwrap(api.GET('/api/v1/me'))).resolves.toEqual({ id: 'me' });
  });

  it('throws a RoosterApiError with the problem code', async () => {
    const f = fakeFetch(() => json(problem, 403, 'application/problem+json'));
    const api = createRoosterClient({ baseUrl: 'http://x', fetch: f.fetch });
    const err = await unwrap(api.GET('/api/v1/me')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoosterApiError);
    expect(err).toMatchObject({ status: 403, code: 'forbidden_scope', problem });
    expect((err as Error).message).toBe('This token cannot write tasks.');
  });

  it('falls back to http_<status> without a problem body', async () => {
    const f = fakeFetch(() => new Response('bad gateway', { status: 502 }));
    const api = createRoosterClient({ baseUrl: 'http://x', fetch: f.fetch });
    await expect(unwrap(api.GET('/api/v1/me'))).rejects.toMatchObject({
      code: 'http_502',
      problem: undefined,
    });
  });
});
