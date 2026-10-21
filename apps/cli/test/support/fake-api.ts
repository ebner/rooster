/**
 * A scripted API for tests that need exact server answers (hostile text, request bodies):
 * routes keyed `METHOD /path` (`*` matches one path segment). Unrouted calls are `404`.
 */
export interface FakeCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

type Handler = (call: FakeCall) => unknown;

export function fakeApi(routes: Record<string, Handler | unknown>) {
  const calls: FakeCall[] = [];
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, path] = key.split(' ') as [string, string];
    const re = new RegExp(
      `^${path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')}$`,
    );
    return { method, re, handler };
  });
  const fetchFn = async (input: Request): Promise<Response> => {
    const url = new URL(input.url);
    const text = input.method === 'GET' ? '' : await input.text();
    const call: FakeCall = {
      method: input.method,
      path: url.pathname,
      search: url.search,
      // OAuth endpoints are form-encoded (RFC 6749); everything else is JSON.
      body:
        text === ''
          ? undefined
          : (input.headers.get('content-type') ?? '').startsWith(
                'application/x-www-form-urlencoded',
              )
            ? Object.fromEntries(new URLSearchParams(text))
            : JSON.parse(text),
    };
    calls.push(call);
    const route = compiled.find((r) => r.method === input.method && r.re.test(url.pathname));
    if (route === undefined) return problem(404, 'not_found', 'Not found.');
    const result =
      typeof route.handler === 'function' ? (route.handler as Handler)(call) : route.handler;
    if (result instanceof Response) return result;
    if (result === undefined) return new Response(null, { status: 204 });
    return Response.json(result);
  };
  return { calls, fetch: fetchFn as unknown as typeof fetch };
}

export function problem(status: number, code: string, detail: string, extra: object = {}) {
  return new Response(
    JSON.stringify({ type: 'about:blank', title: code, status, code, detail, ...extra }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

export const ORG = {
  id: '01a00000-0000-7000-8000-000000000001',
  slug: 'acme',
  name: 'Acme',
  isPersonal: false,
  avatarEmoji: null,
  color: null,
  role: 'owner',
  position: 'a0',
  collapsed: false,
};

export const ME = {
  id: '01a00000-0000-7000-8000-0000000000aa',
  name: 'Ada',
  email: 'ada@example.com',
  image: null,
  locale: 'en',
  timezone: 'UTC',
  weekStart: 1,
  dateFormat: 'MMM d',
  timeFormat: '24h',
  prefs: {},
  isAdmin: false,
  orgs: [ORG],
};

/** Env for a CLI that talks to the fake API with an explicit token. */
export const FAKE_ENV = {
  ROOSTER_SERVER: 'https://rooster.test',
  ROOSTER_TOKEN: 'tok',
  ROOSTER_ORG: 'acme',
};
