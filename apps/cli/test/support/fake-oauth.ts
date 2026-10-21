import { ME } from './fake-api.ts';

/**
 * A scripted rooster authorization server for the device grant and refresh rotation
 * (11 §9.2, §2.4): one grant, approved at once; every refresh rotates both tokens, and a
 * refresh token used twice revokes the grant, as the real server does. `/api/v1/me` accepts
 * only the grant's current API access token; `/mcp` only an MCP one.
 */
export interface FakeOAuthOptions {
  /** `expires_in` of the tokens from the device grant (seconds). */
  loginExpiresIn?: number;
  /** `expires_in` of refreshed tokens (seconds). */
  refreshExpiresIn?: number;
  /** Answer the device authorization with this instead (an older server, the switch off). */
  deviceAuthorization?: () => Response;
  /** Delay before answering a refresh, so concurrent callers overlap. */
  refreshDelayMs?: number;
  /**
   * Rotate on this many refreshes (or answer 503 after rotating, with `lostAs: 'status'`)
   * but lose the answer: the client sees a network failure.
   */
  loseRefreshResponses?: number;
  lostAs?: 'network' | 'status' | 'body';
  /** Fail every refresh with this status, without rotating. */
  refreshStatus?: number;
  scope?: string;
}

export function fakeOAuth(options: FakeOAuthOptions = {}) {
  const state = {
    generation: 0,
    audience: 'api' as 'api' | 'mcp',
    revoked: false,
    reused: false,
    refreshes: 0,
    revocations: [] as Record<string, string>[],
    deviceRequests: [] as Record<string, string>[],
    refreshRequests: [] as Record<string, string>[],
    spentRefresh: new Set<string>(),
    bearers: [] as string[],
    /** The refresh token rotated last, and when: redeemable once more within 60 s (grace). */
    previous: null as { token: string; at: number } | null,
    graceRedemptions: 0,
  };
  let lose = options.loseRefreshResponses ?? 0;
  const access = () => `rooster_at_${state.audience}_${state.generation}`;
  const refresh = () => `rooster_rt_${state.generation}`;
  const issue = (expiresIn: number) =>
    Response.json({
      access_token: access(),
      refresh_token: refresh(),
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: options.scope ?? 'tasks:read tasks:write offline_access',
    });
  const oauthError = (error: string, status = 400) => Response.json({ error }, { status });

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const form =
      request.method === 'POST'
        ? Object.fromEntries(new URLSearchParams(await request.text()))
        : {};
    const bearer = request.headers.get('authorization') ?? '';
    if (bearer !== '') state.bearers.push(bearer);
    switch (`${request.method} ${url.pathname}`) {
      case 'GET /api/v1/meta':
        return Response.json({ version: '1.8.0' });
      case 'POST /api/auth/oauth2/device-authorization': {
        state.deviceRequests.push(form);
        if (options.deviceAuthorization) return options.deviceAuthorization();
        state.audience = form.resource?.endsWith('/mcp') ? 'mcp' : 'api';
        return Response.json({
          device_code: 'device-code-0123456789abcdef',
          user_code: 'KXRT49WM',
          verification_uri: `${url.origin}/device`,
          expires_in: 600,
          interval: 5,
        });
      }
      case 'POST /api/auth/oauth2/token': {
        if (form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
          // A new login: a new grant.
          state.generation = 1;
          state.revoked = false;
          state.spentRefresh.clear();
          return issue(options.loginExpiresIn ?? 900);
        }
        if (form.grant_type !== 'refresh_token') return oauthError('unsupported_grant_type');
        state.refreshRequests.push(form);
        if (options.refreshDelayMs) await new Promise((r) => setTimeout(r, options.refreshDelayMs));
        if (options.refreshStatus !== undefined) {
          return new Response('', { status: options.refreshStatus });
        }
        const presented = form.refresh_token ?? '';
        // The grace period: the previous refresh token once more within 60 s while its
        // successor is unused; the unused successor is revoked.
        const grace =
          !state.revoked &&
          state.previous !== null &&
          presented === state.previous.token &&
          Date.now() - state.previous.at < 60_000 &&
          !state.spentRefresh.has(refresh());
        if (grace) {
          state.graceRedemptions += 1;
          state.previous = null;
        } else if (state.spentRefresh.has(presented)) {
          // Reuse: the whole grant is revoked (11 §2.4).
          state.reused = true;
          state.revoked = true;
        }
        if (!grace && (state.revoked || presented !== refresh())) {
          return oauthError('invalid_grant');
        }
        if (!grace) state.previous = { token: refresh(), at: Date.now() };
        state.spentRefresh.add(presented);
        state.spentRefresh.add(refresh());
        state.generation += 1;
        state.refreshes += 1;
        if (lose > 0) {
          lose -= 1;
          if (options.lostAs === 'status') return new Response('', { status: 503 });
          if (options.lostAs === 'body') {
            // 200 and the headers, then the connection drops mid-body.
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"access_token":"rooster_at_'));
                  controller.error(new TypeError('terminated'));
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          throw new TypeError('fetch failed: the connection was reset');
        }
        return issue(options.refreshExpiresIn ?? 900);
      }
      case 'POST /api/auth/oauth2/revoke':
        state.revocations.push(form);
        if (form.token === refresh()) state.revoked = true;
        return new Response(null, { status: 200 });
      case 'GET /api/v1/me':
        if (state.revoked || state.audience !== 'api' || bearer !== `Bearer ${access()}`) {
          return Response.json(
            { type: 'about:blank', title: 'x', status: 401, code: 'unauthenticated', detail: 'x' },
            { status: 401 },
          );
        }
        return Response.json(ME);
      case 'GET /api/v1/me/grants':
        return Response.json([]);
      default:
        return new Response('Not Found', { status: 404 });
    }
  };
  return { state, handler, fetch: handler as unknown as typeof fetch };
}
