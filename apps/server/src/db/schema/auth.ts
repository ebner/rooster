import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// better-auth tables (05 §2). Their shape follows the better-auth Drizzle adapter: the JS
// property names are better-auth's field names, timestamps are `timestamp_ms` integers.
// These tables are not STRICT (scripts/strictify-migrations.mjs skips them).

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  // rooster's additional fields
  locale: text('locale').notNull().default('en'),
  timezone: text('timezone').notNull().default('UTC'),
  weekStart: integer('week_start').notNull().default(1),
  dateFormat: text('date_format').notNull().default('MMM d'),
  timeFormat: text('time_format').notNull().default('24h'),
  /** JSON object, see `prefsSchema` in @rooster/core. */
  prefs: text('prefs').notNull().default('{}'),
  /** ms epoch; a disabled user cannot sign in and has no sessions. */
  disabledAt: integer('disabled_at'),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /**
     * rooster's: the `access_grant` of a CLI device session (11 §2.4); null for the browser.
     * Revoking the grant deletes the session.
     */
    grantId: text('grant_id'),
  },
  (t) => [index('session_user').on(t.userId), index('session_grant').on(t.grantId)],
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('account_user').on(t.userId),
    uniqueIndex('account_provider_account').on(t.providerId, t.accountId),
  ],
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('verification_identifier').on(t.identifier)],
);
