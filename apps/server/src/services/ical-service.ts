import { createHash, randomBytes } from 'node:crypto';
import { addDays, dueInstant, isValidIsoDate, isValidTime, todayIn } from '@rooster/core/dates';
import { uuidv7 } from '@rooster/core/ids';
import type { IcalFeed, IcalFeedCreate, IcalFeedCreated } from '@rooster/core/schemas';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm';
import { icalFeed, type organization, task, user } from '../db/schema/index.ts';
import { type IcsEvent, renderCalendar } from '../ical/ics.ts';
import { AppError } from '../lib/errors.ts';
import { hashToken } from '../lib/tokens.ts';
import { type Actor, immediate, readOnly, type ServiceDeps, type Tx } from './context.ts';
import { requireBrowserSession } from './grant-access.ts';
import { listMemberships, requireMembership } from './org-access.ts';

/** A feed token: `rcal_` plus 32 random bytes in base64url (ADR 0049 §4.1). */
export const ICAL_TOKEN_PREFIX = 'rcal_';
const TOKEN_RE = /^rcal_[A-Za-z0-9_-]{43}$/;
export const ICAL_FEEDS_MAX = 10;
/** `last_used_at` is written at most this often. */
export const LAST_USED_THROTTLE_MS = 5 * 60_000;
/** Events from this many days ago onwards, at most `ICAL_EVENTS_MAX`. */
export const ICAL_PAST_DAYS = 90;
export const ICAL_EVENTS_MAX = 1000;
/** Timed tasks are 30-minute events (FR-CAL-1). */
const TIMED_EVENT_MS = 30 * 60_000;
/** Subscribers are asked to refresh this often, matching `Cache-Control: max-age=900`. */
export const ICAL_REFRESH_MINUTES = 15;

type FeedRow = typeof icalFeed.$inferSelect;

function toFeedDto(row: FeedRow): IcalFeed {
  return {
    id: row.id,
    orgId: row.orgId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

const feedNotFound = () => new AppError('not_found', 404, 'Calendar feed not found.');

export interface RenderedFeed {
  body: string;
  /** A strong validator over the body. */
  etag: string;
}

/**
 * Calendar feeds (FR-CAL, ADR 0049 §4): a secret URL per feed, stored only as its SHA-256
 * hash and shown once. Managing feeds is a settings action (browser session only); fetching
 * one needs only the token.
 */
export class IcalService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly version: string,
  ) {}

  list(actor: Actor): IcalFeed[] {
    requireBrowserSession(actor);
    return readOnly(this.deps.db, (tx) =>
      tx
        .select()
        .from(icalFeed)
        .where(eq(icalFeed.userId, actor.userId))
        .orderBy(desc(icalFeed.createdAt), desc(icalFeed.id))
        .all()
        .map(toFeedDto),
    );
  }

  /**
   * POST /me/ical-feeds: a feed for one org (a member's live org, else `404`) or for all of the
   * user's orgs. `replaces` regenerates: that feed (the user's own, else `404`) is revoked in
   * the same transaction, so it does not count towards the limit of 10.
   */
  create(actor: Actor, input: IcalFeedCreate): IcalFeedCreated {
    requireBrowserSession(actor);
    const token = `${ICAL_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const row = immediate(this.deps.db, (tx) => {
      const orgId =
        input.orgId == null ? null : requireMembership(tx, actor.userId, input.orgId).org.id;
      if (input.replaces !== undefined) {
        this.requireOwn(tx, actor, input.replaces);
        tx.delete(icalFeed).where(eq(icalFeed.id, input.replaces)).run();
      }
      const existing =
        tx.select({ n: count() }).from(icalFeed).where(eq(icalFeed.userId, actor.userId)).get()
          ?.n ?? 0;
      if (existing >= ICAL_FEEDS_MAX) {
        throw new AppError(
          'too_many_ical_feeds',
          409,
          `You can have at most ${ICAL_FEEDS_MAX} calendar feeds; revoke one first.`,
        );
      }
      const created: FeedRow = {
        id: uuidv7(),
        userId: actor.userId,
        orgId,
        tokenHash: hashToken(token),
        createdAt: this.deps.clock(),
        lastUsedAt: null,
      };
      tx.insert(icalFeed).values(created).run();
      return created;
    });
    return { feed: toFeedDto(row), url: `${this.deps.config.baseUrl}/ical/${token}.ics` };
  }

  /** DELETE /me/ical-feeds/:id: revokes it at once. */
  remove(actor: Actor, feedId: string): void {
    requireBrowserSession(actor);
    immediate(this.deps.db, (tx) => {
      this.requireOwn(tx, actor, feedId);
      tx.delete(icalFeed).where(eq(icalFeed.id, feedId)).run();
    });
  }

  private requireOwn(tx: Tx, actor: Actor, feedId: string): FeedRow {
    const row = tx.select().from(icalFeed).where(eq(icalFeed.id, feedId)).get();
    if (row === undefined || row.userId !== actor.userId) throw feedNotFound();
    return row;
  }

  /**
   * GET /ical/<token>.ics (ADR 0049 §4.2–4.3). Null for anything that is not a live feed: an
   * unknown or revoked token, a disabled user, or an org feed whose user left the org (or
   * whose org was deleted). The route answers those with `404` and counts them as misses.
   */
  render(token: string): RenderedFeed | null {
    if (!TOKEN_RE.test(token)) return null;
    const now = this.deps.clock();
    const result = readOnly(this.deps.db, (tx) => {
      const feed = tx
        .select()
        .from(icalFeed)
        .where(eq(icalFeed.tokenHash, hashToken(token)))
        .get();
      if (feed === undefined) return null;
      const owner = tx
        .select({ timezone: user.timezone, disabledAt: user.disabledAt })
        .from(user)
        .where(eq(user.id, feed.userId))
        .get();
      if (owner === undefined || owner.disabledAt !== null) return null;
      const orgs = listMemberships(tx, feed.userId)
        .map((m) => m.org)
        .filter((o) => feed.orgId === null || o.id === feed.orgId);
      if (feed.orgId !== null && orgs.length === 0) return null;
      const name = feed.orgId === null ? 'rooster' : `rooster – ${orgs[0]?.name ?? ''}`;
      return { feed, name, events: this.events(tx, feed.userId, owner.timezone, orgs, now) };
    });
    if (result === null) return null;
    const { feed } = result;
    if (feed.lastUsedAt === null || now - feed.lastUsedAt >= LAST_USED_THROTTLE_MS) {
      this.deps.db.orm
        .update(icalFeed)
        .set({ lastUsedAt: now })
        .where(eq(icalFeed.id, feed.id))
        .run();
    }
    const body = renderCalendar({
      name: result.name,
      prodId: `-//rooster//rooster ${this.version}//EN`,
      refreshMinutes: ICAL_REFRESH_MINUTES,
      events: result.events,
    });
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 32)}"`;
    return { body, etag };
  }

  /**
   * The user's open, live tasks assigned to them with a due date (subtasks included) in
   * `orgs`, due from 90 days ago (in the user's timezone) onwards, at most 1,000, earliest
   * first. Only the open instance of a recurring task is a task row, so no RRULE is needed.
   */
  private events(
    tx: Tx,
    userId: string,
    timezone: string,
    orgs: readonly (typeof organization.$inferSelect)[],
    now: number,
  ): IcsEvent[] {
    if (orgs.length === 0) return [];
    const slugs = new Map(orgs.map((o) => [o.id, o.slug]));
    const from = addDays(todayIn(timezone, now), -ICAL_PAST_DAYS);
    const rows = tx
      .select({
        id: task.id,
        orgId: task.orgId,
        title: task.title,
        dueDate: task.dueDate,
        dueTime: task.dueTime,
        dueTz: task.dueTz,
        updatedAt: task.updatedAt,
      })
      .from(task)
      .where(
        and(
          eq(task.assigneeId, userId),
          inArray(task.orgId, [...slugs.keys()]),
          isNull(task.deletedAt),
          isNull(task.completedAt),
          isNotNull(task.dueDate),
          gte(task.dueDate, from),
        ),
      )
      .orderBy(asc(task.dueDate), asc(task.dueTime), asc(task.id))
      .limit(ICAL_EVENTS_MAX)
      .all();
    const base = this.deps.config.baseUrl;
    const host = new URL(base).host;
    const events: IcsEvent[] = [];
    for (const r of rows) {
      if (r.dueDate === null || !isValidIsoDate(r.dueDate)) continue;
      const url = `${base}/o/${encodeURIComponent(slugs.get(r.orgId) ?? '')}/t/${r.id}`;
      const timed = r.dueTime !== null && isValidTime(r.dueTime);
      const start = timed ? dueInstant(r.dueDate, r.dueTime ?? '', r.dueTz ?? timezone) : null;
      events.push({
        uid: `${r.id}@${host}`,
        summary: `☐ ${r.title}`,
        description: url,
        url,
        when:
          start === null
            ? { date: r.dueDate, nextDate: addDays(r.dueDate, 1) }
            : { start, end: start + TIMED_EVENT_MS },
        stamp: r.updatedAt,
      });
    }
    return events;
  }
}
