import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Instance-wide key/value settings, e.g. `instance_id`, `vapid_public`, `vapid_private`. */
export const instanceSetting = sqliteTable('instance_setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
