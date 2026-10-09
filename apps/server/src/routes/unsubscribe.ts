import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Config } from '../config.ts';
import { clientIp } from '../lib/client-ip.ts';
import type { AppEnv } from '../lib/context.ts';
import { problemResponse } from '../lib/errors.ts';
import { localeFromAcceptLanguage } from '../lib/i18n.ts';
import { SlidingWindowLimiter } from '../lib/rate-limit.ts';
import { unsubscribePage } from '../mail/unsubscribe-page.tsx';
import type { Services } from '../services/index.ts';

/** Per client IP: generous for people, a brake on token guessing. */
const UNSUBSCRIBE_LIMIT = { max: 30, windowMs: 60_000 };

/**
 * `/unsubscribe/:token` (06 §2.6, outside `/api/v1`, no auth, no CSRF origin check). GET shows a
 * confirmation page whose button POSTs to the same URL; it never changes anything, because mail
 * gateways open links in advance. POST, from that button or a mail client's RFC 8058 one-click
 * (`List-Unsubscribe-Post`, sent with no session and a foreign or null Origin), turns off that
 * category's email cell and answers with the done page. A bad token is a 404 page. Not in the
 * OpenAPI document: it answers HTML, not JSON.
 */
export function registerUnsubscribeRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: { services: Services; config: Config; clock: () => number },
): void {
  const limiter = new SlidingWindowLimiter(UNSUBSCRIBE_LIMIT);
  const appUrl = `${deps.config.baseUrl}/`;
  const handle = (c: Context<AppEnv>, act: boolean) => {
    const wait = limiter.hit(clientIp(c, deps.config) ?? 'unknown', deps.clock());
    if (wait > 0) {
      c.header('Retry-After', String(Math.ceil(wait / 1000)));
      return problemResponse(c, 429, 'rate_limited', 'Too many requests; slow down.');
    }
    const token = c.req.param('token') ?? '';
    const { mail } = deps.services;
    const result = act ? mail.unsubscribe(token) : mail.checkUnsubscribe(token);
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex');
    if (result === null) {
      const locale = localeFromAcceptLanguage(c.req.header('accept-language'));
      return c.html(unsubscribePage({ locale, view: { kind: 'invalid' }, appUrl }), 404);
    }
    const view = {
      kind: act ? ('done' as const) : ('confirm' as const),
      category: result.category,
    };
    return c.html(unsubscribePage({ locale: result.locale, view, appUrl }));
  };
  app.get('/unsubscribe/:token', (c) => handle(c, false));
  app.post('/unsubscribe/:token', (c) => handle(c, true));
}
