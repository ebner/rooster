// Phase 10 (WP 10.3; FR-CAL; ADR 0049 §4): calendar feeds, the ICS writer, caching, the token
// brute-force limit (10 §5) and log redaction.

import type { IcalFeed, IcalFeedCreated, Problem, Task } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { icalFeed, user } from '../src/db/schema/index.ts';
import { escapeText, foldLine, renderCalendar } from '../src/ical/ics.ts';
import { loggablePath } from '../src/lib/request-log.ts';
import { captureLogger, createTestApp, createUserWithSession } from './helpers.ts';
import { type Caller, createTask, listCtx, sharedOrg } from './list-helpers.ts';

const NOW = Date.UTC(2026, 9, 10, 8);

async function team() {
  let now = NOW;
  const clock = { set: (t: number) => (now = t), get: () => now };
  const ctx = listCtx({ clock: () => now });
  const a = ctx.user('ann@example.com', 'Ann');
  const b = ctx.user('bo@example.com', 'Bo');
  const org = await sharedOrg(a, [b], 'Acme');
  return { ...ctx, a, b, org, clock };
}
type Team = Awaited<ReturnType<typeof team>>;

const createFeed = (who: Caller, body: Record<string, unknown> = {}) =>
  who.ok<IcalFeedCreated>('POST', '/api/v1/me/ical-feeds', body, 201);

const fetchFeed = (ctx: Team, url: string, headers: Record<string, string> = {}) =>
  ctx.app.request(new URL(url).pathname, { headers });

function parse(text: string) {
  const cal = new ICAL.Component(ICAL.parse(text));
  const events = cal.getAllSubcomponents('vevent').map((v) => ({
    uid: String(v.getFirstPropertyValue('uid')),
    summary: String(v.getFirstPropertyValue('summary')),
    url: String(v.getFirstPropertyValue('url')),
    description: String(v.getFirstPropertyValue('description')),
    start: v.getFirstPropertyValue('dtstart') as ICAL.Time,
    end: v.getFirstPropertyValue('dtend') as ICAL.Time,
  }));
  return { cal, events };
}

describe('AC-10.3 calendar feed', () => {
  it('lists my open tasks with a due date: all-day and 30-minute timed events', async () => {
    const ctx = await team();
    const { a, b, org } = ctx;
    const allDay = await createTask(a, { title: 'Pay rent', dueDate: '2026-10-12' }, org.id);
    const timed = await createTask(
      a,
      { title: 'Call Bo', dueDate: '2026-10-13', dueTime: '14:30', dueTz: 'Europe/Stockholm' },
      org.id,
    );
    const sub = await createTask(
      a,
      { title: 'Subtask', parentId: allDay.id, dueDate: '2026-10-11', assigneeId: a.userId },
      org.id,
    );
    const recent = await createTask(a, { title: 'Late', dueDate: '2026-07-20' }, org.id);
    const personal = await createTask(a, { title: 'Dentist', dueDate: '2026-10-20' });
    // Not in the feed: no due date, completed, deleted, someone else's, older than 90 days.
    await createTask(a, { title: 'Someday' }, org.id);
    const done = await createTask(a, { title: 'Done', dueDate: '2026-10-12' }, org.id);
    await a.ok('POST', `/api/v1/tasks/${done.id}/complete`, { completed: true });
    const gone = await createTask(a, { title: 'Gone', dueDate: '2026-10-12' }, org.id);
    await a.ok('DELETE', `/api/v1/tasks/${gone.id}`, undefined, 204);
    await createTask(b, { title: 'Bo’s', dueDate: '2026-10-12' }, org.id);
    await createTask(a, { title: 'Ancient', dueDate: '2026-07-01' }, org.id);

    const { feed, url } = await createFeed(a);
    expect(feed.orgId).toBeNull();
    expect(url).toMatch(/^http:\/\/localhost:3000\/ical\/rcal_[A-Za-z0-9_-]{43}\.ics$/);
    const res = await fetchFeed(ctx, url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, max-age=900');
    const text = await res.text();
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/);

    const { cal, events } = parse(text);
    expect(cal.getFirstPropertyValue('x-wr-calname')).toBe('rooster');
    expect(String(cal.getFirstPropertyValue('prodid'))).toMatch(
      /^-\/\/rooster\/\/rooster .+\/\/EN$/,
    );
    expect(cal.getFirstPropertyValue('refresh-interval')?.toString()).toBe('PT15M');
    const byTitle = new Map(events.map((e) => [e.summary, e]));
    expect([...byTitle.keys()].sort()).toEqual(
      ['☐ Call Bo', '☐ Dentist', '☐ Late', '☐ Pay rent', '☐ Subtask'].sort(),
    );

    const rent = byTitle.get('☐ Pay rent');
    expect(rent?.uid).toBe(`${allDay.id}@localhost:3000`);
    expect(rent?.start.isDate).toBe(true);
    expect(rent?.start.toString()).toBe('2026-10-12');
    expect(rent?.end.toString()).toBe('2026-10-13');
    const link = `http://localhost:3000/o/${org.slug}/t/${allDay.id}`;
    expect(rent?.url).toBe(link);
    expect(rent?.description).toBe(link);

    const call = byTitle.get('☐ Call Bo');
    expect(call?.start.isDate).toBe(false);
    expect(call?.start.zone?.tzid).toBe('UTC');
    // 14:30 in Stockholm (CEST, UTC+2) on 13 October.
    expect(call?.start.toJSDate().getTime()).toBe(Date.UTC(2026, 9, 13, 12, 30));
    expect((call?.end.toJSDate().getTime() ?? 0) - (call?.start.toJSDate().getTime() ?? 0)).toBe(
      30 * 60_000,
    );
    expect(timed.id).toBeDefined();
    expect(byTitle.get('☐ Subtask')?.uid).toBe(`${sub.id}@localhost:3000`);
    expect(byTitle.get('☐ Late')?.uid).toBe(`${recent.id}@localhost:3000`);
    expect(byTitle.get('☐ Dentist')?.url).toContain(`/t/${personal.id}`);
  });

  it('an org feed lists that org only and is named after it', async () => {
    const ctx = await team();
    await createTask(ctx.a, { title: 'Org task', dueDate: '2026-10-12' }, ctx.org.id);
    await createTask(ctx.a, { title: 'Private', dueDate: '2026-10-12' });
    const { feed, url } = await createFeed(ctx.a, { orgId: ctx.org.id });
    expect(feed.orgId).toBe(ctx.org.id);
    const { cal, events } = parse(await (await fetchFeed(ctx, url)).text());
    expect(cal.getFirstPropertyValue('x-wr-calname')).toBe('rooster – Acme');
    expect(events.map((e) => e.summary)).toEqual(['☐ Org task']);
    // Not a member: 404.
    const c = ctx.user('cy@example.com');
    const res = await c.call('POST', '/api/v1/me/ical-feeds', { orgId: ctx.org.id });
    expect(res.status).toBe(404);
  });

  it('escapes and folds long titles (UTF-8 safe, CRLF)', async () => {
    const ctx = await team();
    const title = `Möte; om budget, plan\\nästa år 🐓 ${'åäö'.repeat(30)}`;
    await createTask(ctx.a, { title, dueDate: '2026-10-12' });
    const { url } = await createFeed(ctx.a);
    const text = await (await fetchFeed(ctx, url)).text();
    for (const line of text.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    expect(text).toContain('Möte\\; om budget\\, plan\\\\nästa');
    expect(parse(text).events[0]?.summary).toBe(`☐ ${title}`);
  });

  it('answers 304 for a matching ETag, and a new ETag after a change', async () => {
    const ctx = await team();
    const t = await createTask(ctx.a, { title: 'One', dueDate: '2026-10-12' });
    const { url } = await createFeed(ctx.a);
    const first = await fetchFeed(ctx, url);
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    const again = await fetchFeed(ctx, url, { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
    expect(await again.text()).toBe('');
    expect((await fetchFeed(ctx, url, { 'if-none-match': `W/${etag}` })).status).toBe(304);
    ctx.clock.set(NOW + 60_000);
    await ctx.a.ok<Task>('PATCH', `/api/v1/tasks/${t.id}`, { title: 'Renamed' });
    const changed = await fetchFeed(ctx, url, { 'if-none-match': etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
  });

  it('regenerates (the old URL stops working) and revokes', async () => {
    const ctx = await team();
    const first = await createFeed(ctx.a);
    const second = await createFeed(ctx.a, { replaces: first.feed.id });
    expect((await fetchFeed(ctx, first.url)).status).toBe(404);
    expect((await fetchFeed(ctx, second.url)).status).toBe(200);
    const list = await ctx.a.ok<IcalFeed[]>('GET', '/api/v1/me/ical-feeds');
    expect(list.map((f) => f.id)).toEqual([second.feed.id]);
    // Someone else's feed is not found, for replacing and revoking alike.
    expect(
      (await ctx.b.call('POST', '/api/v1/me/ical-feeds', { replaces: second.feed.id })).status,
    ).toBe(404);
    expect((await ctx.b.call('DELETE', `/api/v1/me/ical-feeds/${second.feed.id}`)).status).toBe(
      404,
    );
    await ctx.a.ok('DELETE', `/api/v1/me/ical-feeds/${second.feed.id}`, undefined, 204);
    expect((await fetchFeed(ctx, second.url)).status).toBe(404);
  });

  it('allows 10 feeds; replacing one at the limit still works', async () => {
    const ctx = await team();
    const feeds: IcalFeedCreated[] = [];
    for (let i = 0; i < 10; i++) feeds.push(await createFeed(ctx.a));
    const res = await ctx.a.call('POST', '/api/v1/me/ical-feeds', {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe('too_many_ical_feeds');
    await createFeed(ctx.a, { replaces: feeds[0]?.feed.id });
  });

  it('stores only the hash and never replays the URL', async () => {
    const ctx = await team();
    const created = await ctx.a.ok<IcalFeedCreated>('POST', '/api/v1/me/ical-feeds', {}, 201, {
      'idempotency-key': 'feed-1',
    });
    const token = new URL(created.url).pathname.slice('/ical/'.length, -'.ics'.length);
    const stored = ctx.db.orm.select().from(icalFeed).get();
    expect(stored?.tokenHash).not.toContain(token);
    expect(JSON.stringify(stored)).not.toContain(token);
    const replay = await ctx.a.call(
      'POST',
      '/api/v1/me/ical-feeds',
      {},
      { 'idempotency-key': 'feed-1' },
    );
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as Problem).code).toBe('token_shown_once');
  });

  it('is 404 for a disabled user and for an org feed after leaving the org', async () => {
    const ctx = await team();
    const orgFeed = await createFeed(ctx.b, { orgId: ctx.org.id });
    const allFeed = await createFeed(ctx.b);
    await ctx.b.ok('DELETE', `/api/v1/orgs/${ctx.org.id}/members/${ctx.b.userId}`, undefined, 204);
    expect((await fetchFeed(ctx, orgFeed.url)).status).toBe(404);
    expect((await fetchFeed(ctx, allFeed.url)).status).toBe(200);
    ctx.db.orm.update(user).set({ disabledAt: NOW }).where(eq(user.id, ctx.b.userId)).run();
    expect((await fetchFeed(ctx, allFeed.url)).status).toBe(404);
  });

  it('writes last_used_at at most every 5 minutes', async () => {
    const ctx = await team();
    const { feed, url } = await createFeed(ctx.a);
    const lastUsed = () =>
      ctx.db.orm.select().from(icalFeed).where(eq(icalFeed.id, feed.id)).get()?.lastUsedAt;
    expect(lastUsed()).toBeNull();
    await fetchFeed(ctx, url);
    expect(lastUsed()).toBe(NOW);
    ctx.clock.set(NOW + 4 * 60_000);
    await fetchFeed(ctx, url);
    expect(lastUsed()).toBe(NOW);
    ctx.clock.set(NOW + 5 * 60_000);
    await fetchFeed(ctx, url);
    expect(lastUsed()).toBe(NOW + 5 * 60_000);
  });

  it('limits token guessing: more than 20 misses per IP in 10 minutes is 429', async () => {
    const ctx = await team();
    const { url } = await createFeed(ctx.a);
    const guess = (i: number) => ctx.app.request(`/ical/rcal_${String(i).padStart(43, 'x')}.ics`);
    for (let i = 0; i < 20; i++) expect((await guess(i)).status).toBe(404);
    const blocked = await guess(21);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // A right guess from that IP is refused alike, so a hit cannot be told from a miss.
    expect((await fetchFeed(ctx, url)).status).toBe(429);
    ctx.clock.set(NOW + 10 * 60_000 + 1);
    expect((await fetchFeed(ctx, url)).status).toBe(200);
    // A malformed name counts as a miss too.
    expect((await ctx.app.request('/ical/whatever')).status).toBe(404);
  });

  it('keeps the token out of the request log', async () => {
    expect(loggablePath('/ical/rcal_abc.ics')).toBe('/ical/:token');
    const { logger, lines } = captureLogger();
    const { app, db } = createTestApp({ logger });
    const u = createUserWithSession(app, db, { email: 'ann@example.com' });
    const actor = app.services.users.resolveActor(u.userId, u.sessionId);
    if (actor === null) throw new Error('actor');
    const { url } = app.services.icalFeeds.create(actor, {});
    const path = new URL(url).pathname;
    expect((await app.request(path)).status).toBe(200);
    const token = path.slice('/ical/'.length);
    const logged = lines.filter((l) => l.msg === 'request');
    expect(logged.some((l) => l.path === '/ical/:token')).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(token);
  });
});

describe('ICS writer', () => {
  it('escapes TEXT values', () => {
    expect(escapeText('a\\b;c,d\ne\r\nf\u0007')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
  });

  it('folds at 75 octets without splitting a character', () => {
    const line = `SUMMARY:${'🐓'.repeat(40)}`;
    const folded = foldLine(line).split('\r\n');
    expect(folded.length).toBeGreaterThan(1);
    for (const part of folded) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
    expect(folded.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(line);
    expect(foldLine('SHORT:x')).toBe('SHORT:x');
  });

  it('renders an empty calendar that parses', () => {
    const text = renderCalendar({
      name: 'rooster',
      prodId: '-//rooster//rooster 0.0.0//EN',
      refreshMinutes: 15,
      events: [],
    });
    expect(new ICAL.Component(ICAL.parse(text)).getAllSubcomponents('vevent')).toEqual([]);
  });
});
