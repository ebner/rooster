-- Hand-written (drizzle-kit generate --custom): drizzle cannot declare FTS5 virtual tables.
-- Full-text search over tasks (05 §3, 04 §4.7). Keyed by task_id (UNINDEXED), never by
-- task.rowid: VACUUM may renumber rowids of tables without an INTEGER PRIMARY KEY.
-- SearchService keeps one row per non-deleted task, in the same transaction as the write.
CREATE VIRTUAL TABLE `task_fts` USING fts5(
	task_id UNINDEXED, org_id UNINDEXED,
	title, description, comments,
	tokenize='unicode61 remove_diacritics 2', prefix='2 3 4'
);
--> statement-breakpoint
INSERT INTO `task_fts` (task_id, org_id, title, description, comments)
SELECT `id`, `org_id`, `title`, `description`, '' FROM `task` WHERE `deleted_at` IS NULL;
