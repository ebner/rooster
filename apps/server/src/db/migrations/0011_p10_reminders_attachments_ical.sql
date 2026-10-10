CREATE TABLE `attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`org_id` text NOT NULL,
	`uploader_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`storage` text NOT NULL,
	`key` text NOT NULL,
	`thumb_key` text,
	`width` integer,
	`height` integer,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploader_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attachment_storage" CHECK(storage IN ('local','s3'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `attachment_task` ON `attachment` (`task_id`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE TABLE `blob_gc` (
	`key` text PRIMARY KEY NOT NULL,
	`storage` text NOT NULL,
	`queued_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `ical_feed` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `ical_feed_token_hash_unique` ON `ical_feed` (`token_hash`);--> statement-breakpoint
CREATE TABLE `task_reminder` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`offset_minutes` integer,
	`remind_at` integer,
	`fire_at` integer,
	`fired_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_reminder_kind" CHECK(kind IN ('relative','absolute')),
	CONSTRAINT "task_reminder_relative" CHECK((kind = 'relative') = (offset_minutes IS NOT NULL)),
	CONSTRAINT "task_reminder_absolute" CHECK((kind = 'absolute') = (remind_at IS NOT NULL)),
	CONSTRAINT "task_reminder_offset" CHECK(offset_minutes IS NULL OR offset_minutes BETWEEN 0 AND 40320)
) STRICT;
--> statement-breakpoint
CREATE INDEX `task_reminder_due` ON `task_reminder` (`fire_at`) WHERE fired_at IS NULL;--> statement-breakpoint
CREATE INDEX `task_reminder_task` ON `task_reminder` (`task_id`,`user_id`);--> statement-breakpoint
ALTER TABLE `user` ADD `avatar_at` integer;--> statement-breakpoint
ALTER TABLE `user` ADD `oidc_image` text;--> statement-breakpoint
CREATE INDEX `task_series_open` ON `task` (`series_id`) WHERE series_id IS NOT NULL AND deleted_at IS NULL AND completed_at IS NULL;--> statement-breakpoint
-- ADR 0049 §3.6: queue the blobs of every deleted attachment row for the blob GC job.
CREATE TRIGGER `attachment_blob_gc` AFTER DELETE ON `attachment` BEGIN
  INSERT OR IGNORE INTO `blob_gc` (`key`, `storage`, `queued_at`)
    VALUES (old.`key`, old.`storage`, CAST(unixepoch('subsec') * 1000 AS INTEGER));
  INSERT OR IGNORE INTO `blob_gc` (`key`, `storage`, `queued_at`)
    SELECT old.`thumb_key`, old.`storage`, CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE old.`thumb_key` IS NOT NULL;
END;
