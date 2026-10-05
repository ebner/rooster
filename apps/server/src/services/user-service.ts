import { DATE_FORMATS, type DateFormat, TIME_FORMATS, type TimeFormat } from '@rooster/core/dates';
import { generateNKeysBetween, keyBetween, needsRebalance } from '@rooster/core/ordering';
import {
  type Me,
  type MePatch,
  type Org,
  type OrgOrder,
  type OrgOrderResult,
  PERSONAL_ORG_ALIAS,
  resolvePrefs,
  type Session,
} from '@rooster/core/schemas';
import { isLocale } from '@rooster/i18n';
import { and, desc, eq, gt } from 'drizzle-orm';
import { orgMemberPref, session, user } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import { type Actor, immediate, isAdminEmail, type ServiceDeps, type Tx } from './context.ts';
import {
  listMemberships,
  type Membership,
  notFound,
  requireMembership,
  toOrgDto,
} from './org-access.ts';

type UserRow = typeof user.$inferSelect;

function oneOf<T extends string>(options: readonly T[], value: string, fallback: T): T {
  return (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** `utc` → `UTC`, `europe/stockholm` → `Europe/Stockholm`. Input is already validated. */
function canonicalTimeZone(tz: string): string {
  return new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone;
}

function matchesRef(m: Membership, ref: string): boolean {
  return m.org.id === ref || m.org.slug === ref || (ref === PERSONAL_ORG_ALIAS && m.org.isPersonal);
}

/** The signed-in user: profile, settings, sessions and sidebar order (FR-SET-1/3, FR-ORG-6). */
export class UserService {
  constructor(private readonly deps: ServiceDeps) {}

  /** Resolves the actor of a session; `null` for a missing or disabled user. */
  resolveActor(userId: string, sessionId: string): Actor | null {
    const row = this.deps.db.orm
      .select({ email: user.email, emailVerified: user.emailVerified, disabledAt: user.disabledAt })
      .from(user)
      .where(eq(user.id, userId))
      .get();
    if (row === undefined || row.disabledAt !== null) return null;
    return {
      userId,
      email: row.email,
      isAdmin: row.emailVerified && isAdminEmail(this.deps.config, row.email),
      via: 'session',
      sessionId,
      scopes: ['read', 'write'],
    };
  }

  private toMe(tx: Tx, actor: Actor, row: UserRow): Me {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      image: row.image,
      locale: isLocale(row.locale) ? row.locale : 'en',
      timezone: row.timezone,
      weekStart: row.weekStart === 0 ? 0 : 1,
      dateFormat: oneOf<DateFormat>(DATE_FORMATS, row.dateFormat, 'MMM d'),
      timeFormat: oneOf<TimeFormat>(TIME_FORMATS, row.timeFormat, '24h'),
      prefs: resolvePrefs(parseJson(row.prefs)),
      isAdmin: actor.isAdmin,
      orgs: listMemberships(tx, actor.userId).map(toOrgDto),
    };
  }

  private requireUser(tx: Tx, userId: string): UserRow {
    const row = tx.select().from(user).where(eq(user.id, userId)).get();
    if (row === undefined) throw notFound('User');
    return row;
  }

  getMe(actor: Actor): Me {
    return immediate(this.deps.db, (tx) =>
      this.toMe(tx, actor, this.requireUser(tx, actor.userId)),
    );
  }

  updateMe(actor: Actor, patch: MePatch): Me {
    return immediate(this.deps.db, (tx) => {
      const current = this.requireUser(tx, actor.userId);
      const changes: Partial<UserRow> = {};
      if (patch.name !== undefined) changes.name = patch.name;
      if (patch.locale !== undefined) changes.locale = patch.locale;
      if (patch.timezone !== undefined) changes.timezone = canonicalTimeZone(patch.timezone);
      if (patch.weekStart !== undefined) changes.weekStart = patch.weekStart;
      if (patch.dateFormat !== undefined) changes.dateFormat = patch.dateFormat;
      if (patch.timeFormat !== undefined) changes.timeFormat = patch.timeFormat;
      if (patch.prefs !== undefined) {
        const stored = parseJson(current.prefs);
        const merged = {
          ...(stored !== null && typeof stored === 'object' ? stored : {}),
          ...Object.fromEntries(Object.entries(patch.prefs).filter(([, v]) => v !== undefined)),
        };
        changes.prefs = JSON.stringify(merged);
      }
      if (Object.keys(changes).length === 0) return this.toMe(tx, actor, current);
      changes.updatedAt = new Date(this.deps.clock());
      tx.update(user).set(changes).where(eq(user.id, actor.userId)).run();
      return this.toMe(tx, actor, { ...current, ...changes });
    });
  }

  /** Active sessions, most recently used first. */
  listSessions(actor: Actor): Session[] {
    return immediate(this.deps.db, (tx) =>
      tx
        .select()
        .from(session)
        .where(
          and(eq(session.userId, actor.userId), gt(session.expiresAt, new Date(this.deps.clock()))),
        )
        .orderBy(desc(session.updatedAt), desc(session.id))
        .all()
        .map((row) => ({
          id: row.id,
          createdAt: row.createdAt.getTime(),
          updatedAt: row.updatedAt.getTime(),
          expiresAt: row.expiresAt.getTime(),
          ipAddress: row.ipAddress || null,
          userAgent: row.userAgent || null,
          current: row.id === actor.sessionId,
        })),
    );
  }

  /**
   * Revokes one of the actor's sessions. `cookieCache` is disabled, so the browser holding
   * it is signed out on its next request (AC-1.7).
   */
  revokeSession(actor: Actor, sessionId: string): void {
    immediate(this.deps.db, (tx) => {
      const result = tx
        .delete(session)
        .where(and(eq(session.id, sessionId), eq(session.userId, actor.userId)))
        .run();
      if (result.changes === 0) throw notFound('Session');
    });
  }

  /**
   * Moves an org in the actor's sidebar from a `{beforeId, afterId}` intent (06 §1). An
   * intent that does not match the current order falls back to the end.
   */
  reorderOrg(actor: Actor, input: OrgOrder): OrgOrderResult {
    return immediate(this.deps.db, (tx) => {
      const target = requireMembership(tx, actor.userId, input.orgId);
      const others = listMemberships(tx, actor.userId).filter((m) => m.org.id !== target.org.id);
      const index = this.insertionIndex(others, input.afterId ?? null, input.beforeId ?? null);
      const above = others[index - 1]?.position ?? null;
      const below = others[index]?.position ?? null;
      let position: string | null = null;
      try {
        position = keyBetween(above, below);
      } catch {
        position = null;
      }
      if (position === null || needsRebalance(position)) {
        // Re-key the whole sidebar in the intended order.
        const ordered = [...others.slice(0, index), target, ...others.slice(index)];
        const keys = generateNKeysBetween(null, null, ordered.length);
        ordered.forEach((m, i) => {
          this.setPosition(tx, actor.userId, m.org.id, keys[i] as string);
        });
        position = keys[index] as string;
      } else {
        this.setPosition(tx, actor.userId, target.org.id, position);
      }
      return { orgId: target.org.id, position };
    });
  }

  /** Index in `others` (the sidebar without the moved org) where the org goes. */
  private insertionIndex(others: Membership[], afterRef: string | null, beforeRef: string | null) {
    const end = others.length;
    const after = afterRef === null ? -1 : others.findIndex((m) => matchesRef(m, afterRef));
    const before = beforeRef === null ? -1 : others.findIndex((m) => matchesRef(m, beforeRef));
    if (afterRef !== null && after === -1) return end;
    if (beforeRef !== null && before === -1) return end;
    if (afterRef === null && beforeRef === null) return end;
    if (afterRef === null) return before;
    if (beforeRef === null) return after + 1;
    return before === after + 1 ? before : end;
  }

  private setPosition(tx: Tx, userId: string, orgId: string, position: string): void {
    tx.insert(orgMemberPref)
      .values({ userId, orgId, position, collapsed: false })
      .onConflictDoUpdate({
        target: [orgMemberPref.userId, orgMemberPref.orgId],
        set: { position },
      })
      .run();
  }

  /** The sidebar section's collapse state (`org_member_pref.collapsed`). */
  setOrgCollapsed(actor: Actor, ref: string, collapsed: boolean): Org {
    return immediate(this.deps.db, (tx) => {
      const membership = requireMembership(tx, actor.userId, ref);
      const result = tx
        .update(orgMemberPref)
        .set({ collapsed })
        .where(
          and(eq(orgMemberPref.userId, actor.userId), eq(orgMemberPref.orgId, membership.org.id)),
        )
        .run();
      if (result.changes === 0) throw new AppError('not_found', 404, 'Organisation not found.');
      return toOrgDto({ ...membership, collapsed });
    });
  }
}
