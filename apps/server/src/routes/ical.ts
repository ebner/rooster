import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { icalFeedCreatedSchema, icalFeedCreateSchema, icalFeedSchema } from '@rooster/core/schemas';
import type { Config } from '../config.ts';
import { clientIp } from '../lib/client-ip.ts';
import type { AppEnv } from '../lib/context.ts';
import { problemResponse } from '../lib/errors.ts';
import { named } from '../lib/openapi.ts';
import type { Services } from '../services/index.ts';
import { AUTHED, actorOf, idParam, json, optionalBody, problems } from './common.ts';

export const IcalFeedSchema = named(icalFeedSchema, 'IcalFeed');
export const IcalFeedListSchema = named(z.array(IcalFeedSchema), 'IcalFeedList');
export const IcalFeedCreateSchema = named(icalFeedCreateSchema, 'IcalFeedCreate');
export const IcalFeedCreatedSchema = named(
  icalFeedCreatedSchema.extend({ feed: IcalFeedSchema }),
  'IcalFeedCreated',
);

/** 10 §5, ADR 0049 §4.2: more than 20 unknown tokens per IP in 10 minutes is `429`. */
export const ICAL_MISS_LIMIT = { max: 20, windowMs: 10 * 60_000 };

/**
 * Misses (unknown tokens) per client IP in a sliding window. Only misses count, so a calendar
 * polling a valid feed is never limited; once an IP is over the limit every request from it
 * is refused, so a guess that happens to hit cannot be told apart from one that misses.
 */
export class MissLimiter {
  private readonly misses = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly options: { max: number; windowMs: number }) {}

  /** ms until the IP may try again; 0 when it is not blocked. */
  blockedFor(ip: string, now: number): number {
    this.sweep(now);
    const since = now - this.options.windowMs;
    const list = (this.misses.get(ip) ?? []).filter((t) => t > since);
    if (list.length < this.options.max) return 0;
    return Math.max(1, (list[list.length - this.options.max] ?? now) + this.options.windowMs - now);
  }

  record(ip: string, now: number): void {
    const since = now - this.options.windowMs;
    const list = (this.misses.get(ip) ?? []).filter((t) => t > since);
    list.push(now);
    this.misses.set(ip, list);
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.options.windowMs) return;
    this.lastSweep = now;
    const since = now - this.options.windowMs;
    for (const [ip, list] of this.misses) {
      if ((list[list.length - 1] ?? 0) <= since) this.misses.delete(ip);
    }
  }
}

const listFeeds = createRoute({
  method: 'get',
  path: '/api/v1/me/ical-feeds',
  tags: ['calendar'],
  operationId: 'listIcalFeeds',
  summary: 'My calendar feeds (browser session only)',
  description: 'The feed URLs themselves are secret and only shown when a feed is created.',
  responses: { 200: json(IcalFeedListSchema, 'Feeds, newest first'), ...problems(401) },
});

const createFeed = createRoute({
  method: 'post',
  path: '/api/v1/me/ical-feeds',
  tags: ['calendar'],
  operationId: 'createIcalFeed',
  summary: 'Create a calendar feed URL (shown once; browser session only)',
  description:
    'A private `.ics` URL with my open tasks that have a due date: for one organisation (`orgId`) or all of them. `replaces` regenerates a feed: the old URL stops working in the same step. At most 10 feeds (`409 too_many_ical_feeds`). The URL is returned only in this response; a replay of the same `Idempotency-Key` is `409 token_shown_once`.',
  request: { body: optionalBody(IcalFeedCreateSchema) },
  responses: {
    201: json(IcalFeedCreatedSchema, 'The feed and its secret URL'),
    ...problems(...AUTHED, 404, 'too_many_ical_feeds'),
  },
});

const deleteFeed = createRoute({
  method: 'delete',
  path: '/api/v1/me/ical-feeds/{id}',
  tags: ['calendar'],
  operationId: 'deleteIcalFeed',
  summary: 'Revoke a calendar feed (browser session only)',
  description: 'Its URL answers `404` from now on. Another user’s feed is `404`.',
  request: { params: z.object({ id: idParam('id', 'Feed ID') }) },
  responses: { 204: { description: 'Revoked' }, ...problems(...AUTHED, 404) },
});

const getFeed = createRoute({
  method: 'get',
  path: '/ical/{file}',
  tags: ['calendar'],
  operationId: 'getIcalFeed',
  summary: 'A calendar feed (iCalendar; the token is the credential)',
  description:
    'Outside `/api/v1` and without authentication: the secret token in the URL is the credential. My open tasks assigned to me with a due date, from 90 days ago on (at most 1,000): an all-day event for a date, a 30-minute event for a date with a time. Cacheable for 15 minutes (`ETag`, `304`). An unknown or revoked token is `404`; more than 20 of those from one IP within 10 minutes is `429`.',
  request: {
    params: z.object({
      file: z
        .string()
        .min(1)
        .openapi({
          param: { name: 'file', in: 'path' },
          description: '`<token>.ics`',
          example: 'rcal_8Kx1q0ZpVb3mT2yWc9dLr5nA7fGh4jE6sUo0iQ1zXk.ics',
        }),
    }),
  },
  responses: {
    200: {
      description: 'The calendar',
      headers: {
        ETag: { description: 'A validator over the body', schema: { type: 'string' } },
        'Cache-Control': { description: '`private, max-age=900`', schema: { type: 'string' } },
      },
      content: { 'text/calendar': { schema: z.string() } },
    },
    304: { description: 'Not modified (`If-None-Match` matched the `ETag`)' },
    ...problems(404, 429),
  },
});

const FEED_HEADERS = {
  'Cache-Control': 'private, max-age=900',
  'X-Robots-Tag': 'noindex',
};

/** Whether an `If-None-Match` header names the ETag (weak comparison, RFC 9110 §13.1.2). */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === '*') return true;
  return header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .includes(etag);
}

/** Calendar feeds (06 §2.8, FR-CAL, ADR 0049 §4). */
export function registerIcalRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: { services: Services; config: Config; clock: () => number },
): void {
  const { icalFeeds } = deps.services;
  app.openapi(listFeeds, (c) => c.json(icalFeeds.list(actorOf(c)), 200));
  app.openapi(createFeed, (c) => {
    const actor = actorOf(c);
    // The URL is a secret: the idempotency store keeps no body and refuses replays.
    c.set('secretResponse', true);
    return c.json(icalFeeds.create(actor, c.req.valid('json') ?? {}), 201);
  });
  app.openapi(deleteFeed, (c) => {
    icalFeeds.remove(actorOf(c), c.req.valid('param').id);
    return c.body(null, 204);
  });

  const misses = new MissLimiter(ICAL_MISS_LIMIT);
  app.openapi(getFeed, (c) => {
    const ip = clientIp(c, deps.config) ?? 'unknown';
    const now = deps.clock();
    const wait = misses.blockedFor(ip, now);
    if (wait > 0) {
      c.header('Retry-After', String(Math.ceil(wait / 1000)));
      return problemResponse(c, 429, 'rate_limited', 'Too many requests; slow down.');
    }
    const file = c.req.valid('param').file;
    const feed = file.endsWith('.ics') ? icalFeeds.render(file.slice(0, -4)) : null;
    if (feed === null) {
      misses.record(ip, now);
      return problemResponse(c, 404, 'not_found', 'Calendar feed not found.');
    }
    if (matchesEtag(c.req.header('if-none-match'), feed.etag)) {
      return c.body(null, 304, { ETag: feed.etag, ...FEED_HEADERS });
    }
    return c.body(feed.body, 200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      ETag: feed.etag,
      ...FEED_HEADERS,
    });
  });
}
