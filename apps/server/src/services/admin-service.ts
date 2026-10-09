import { uuidv7 } from '@rooster/core/ids';
import type {
  AdminUser,
  AllowlistCreate,
  AllowlistEntry,
  AllowlistKind,
} from '@rooster/core/schemas';
import { asc, desc, eq } from 'drizzle-orm';
import { allowlistEntry, session, user } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import {
  type Actor,
  emitAfterCommit,
  immediate,
  isAdminEmail,
  type ServiceDeps,
  type Tx,
} from './context.ts';
import { requireBrowserSession } from './grant-access.ts';
import { notFound } from './org-access.ts';

function requireAdmin(actor: Actor): void {
  if (!actor.isAdmin) throw new AppError('forbidden', 403, 'Only instance admins can do that.');
}

/** Instance administration: the sign-in allowlist and users (FR-AUTH-8, WP 1.6). */
export class AdminService {
  constructor(private readonly deps: ServiceDeps) {}

  listAllowlist(actor: Actor): AllowlistEntry[] {
    requireBrowserSession(actor);
    requireAdmin(actor);
    return immediate(this.deps.db, (tx) =>
      tx
        .select({
          id: allowlistEntry.id,
          kind: allowlistEntry.kind,
          value: allowlistEntry.value,
          createdAt: allowlistEntry.createdAt,
        })
        .from(allowlistEntry)
        .orderBy(asc(allowlistEntry.kind), asc(allowlistEntry.value))
        .all(),
    );
  }

  addAllowlist(actor: Actor, input: AllowlistCreate): AllowlistEntry {
    requireBrowserSession(actor);
    requireAdmin(actor);
    return immediate(this.deps.db, (tx) => {
      const value = input.value.trim().toLowerCase();
      // `value` is COLLATE NOCASE, so this also catches case variants.
      const existing = tx
        .select({ id: allowlistEntry.id })
        .from(allowlistEntry)
        .where(eq(allowlistEntry.value, value))
        .get();
      if (existing !== undefined) {
        throw new AppError('already_exists', 409, 'That entry is already on the allowlist.');
      }
      const entry = {
        id: uuidv7(),
        kind: input.kind as AllowlistKind,
        value,
        createdAt: this.deps.clock(),
      };
      tx.insert(allowlistEntry)
        .values({ ...entry, createdBy: actor.userId })
        .run();
      return entry;
    });
  }

  removeAllowlist(actor: Actor, id: string): void {
    requireBrowserSession(actor);
    requireAdmin(actor);
    immediate(this.deps.db, (tx) => {
      const result = tx.delete(allowlistEntry).where(eq(allowlistEntry.id, id)).run();
      if (result.changes === 0) throw notFound('Allowlist entry');
    });
  }

  listUsers(actor: Actor): AdminUser[] {
    requireBrowserSession(actor);
    requireAdmin(actor);
    return immediate(this.deps.db, (tx) =>
      tx
        .select()
        .from(user)
        .orderBy(desc(user.createdAt), desc(user.id))
        .all()
        .map((row) => this.toAdminUser(row)),
    );
  }

  /** Disabling also deletes every session, so the user is signed out everywhere at once. */
  setDisabled(actor: Actor, userId: string, disabled: boolean): AdminUser {
    requireBrowserSession(actor);
    requireAdmin(actor);
    if (disabled && userId === actor.userId) {
      throw new AppError('cannot_disable_self', 409, 'You cannot deactivate your own account.');
    }
    return immediate(this.deps.db, (tx) => {
      const row = this.requireUser(tx, userId);
      const disabledAt = disabled ? (row.disabledAt ?? this.deps.clock()) : null;
      tx.update(user)
        .set({ disabledAt, updatedAt: new Date(this.deps.clock()) })
        .where(eq(user.id, userId))
        .run();
      if (disabled) {
        tx.delete(session).where(eq(session.userId, userId)).run();
        // Force-closes every open SSE stream of the user (04 §4.5).
        emitAfterCommit(this.deps, tx, {
          type: 'user.disabled',
          orgId: null,
          actorId: actor.userId,
          subjects: [userId],
          audiences: [],
        });
      }
      return this.toAdminUser({ ...row, disabledAt });
    });
  }

  private requireUser(tx: Tx, userId: string) {
    const row = tx.select().from(user).where(eq(user.id, userId)).get();
    if (row === undefined) throw notFound('User');
    return row;
  }

  private toAdminUser(row: typeof user.$inferSelect): AdminUser {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      image: row.image,
      createdAt: row.createdAt.getTime(),
      disabledAt: row.disabledAt,
      isAdmin: row.emailVerified && isAdminEmail(this.deps.config, row.email),
    };
  }
}
