import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { user } from './auth.ts';

// Rooster-owned organisation tables (ADR 0002). Their columns follow the better-auth
// organization-plugin shape plus 05 §2's additional fields, but they are managed only by
// OrgService. Timestamps are ms-epoch integers.

export const organization = sqliteTable(
  'organization',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    logo: text('logo'),
    metadata: text('metadata'),
    createdAt: integer('created_at').notNull(),
    isPersonal: integer('is_personal', { mode: 'boolean' }).notNull().default(false),
    avatarEmoji: text('avatar_emoji'),
    /** Tag palette name (03 §2.4). */
    color: text('color'),
    taskSeq: integer('task_seq').notNull().default(0),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    // A deleted org frees its slug.
    uniqueIndex('organization_slug').on(t.slug).where(sql`deleted_at IS NULL`),
  ],
);

export const member = sqliteTable(
  'member',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'member'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('member_org_user').on(t.organizationId, t.userId),
    index('member_user').on(t.userId),
    check('member_role', sql`role IN ('owner','member')`),
  ],
);

/** Email invites only; link invites live in `invite_link`. */
export const invitation = sqliteTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: ['owner', 'member'] }).notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'canceled', 'rejected'] })
      .notNull()
      .default('pending'),
    expiresAt: integer('expires_at').notNull(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('invitation_org').on(t.organizationId, t.status),
    index('invitation_email').on(t.email, t.status),
    check('invitation_role', sql`role IN ('owner','member')`),
    check('invitation_status', sql`status IN ('pending','accepted','canceled','rejected')`),
  ],
);

export const inviteLink = sqliteTable(
  'invite_link',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    role: text('role', { enum: ['owner', 'member'] }).notNull(),
    multiUse: integer('multi_use', { mode: 'boolean' }).notNull().default(false),
    uses: integer('uses').notNull().default(0),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    createdAt: integer('created_at').notNull(),
  },
  () => [check('invite_link_role', sql`role IN ('owner','member')`)],
);

/** Sidebar order and per-org UI prefs for a user. */
export const orgMemberPref = sqliteTable(
  'org_member_pref',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** Fractional key: sidebar order. */
    position: text('position').notNull(),
    collapsed: integer('collapsed', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.orgId] })],
);
