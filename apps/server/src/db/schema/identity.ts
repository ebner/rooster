import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { user } from './auth.ts';

/**
 * A sign-in identity the user removed in Settings → Security (FR-SET-3). Email authorities link
 * by email (FR-AUTH-5), so without this row the next sign-in through the removed identity would
 * attach it again. While the row exists, better-auth may not create an `account` for this
 * (provider, subject) pair (`databaseHooks.account.create.before`); the user allows it again by
 * deleting the row. `id` is the removed `account` row's id, `email` the address its ID token
 * vouched for (display only).
 */
export const unlinkedIdentity = sqliteTable(
  'unlinked_identity',
  {
    id: text('id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    email: text('email'),
    unlinkedAt: integer('unlinked_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.providerId, t.accountId] }),
    uniqueIndex('unlinked_identity_id').on(t.id),
    index('unlinked_identity_user').on(t.userId),
  ],
);
