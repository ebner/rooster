CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`org_id` text NOT NULL,
	`actor_id` text,
	`type` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `activity_task` ON `activity` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `comment` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "comment_body" CHECK(length(body) BETWEEN 1 AND 20000)
) STRICT;
--> statement-breakpoint
CREATE INDEX `comment_task` ON `comment` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `follower` (
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`task_id`, `user_id`),
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE TABLE `notification` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`type` text NOT NULL,
	`task_id` text,
	`actor_id` text,
	`data` text DEFAULT '{}' NOT NULL,
	`read_at` integer,
	`emailed_at` integer,
	`pushed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `notification_inbox` ON `notification` (`user_id`,`read_at`,"created_at" DESC);--> statement-breakpoint
CREATE TABLE `notification_pref` (
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`channel` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`user_id`, `type`, `channel`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_pref_channel" CHECK(channel IN ('inapp','push','email'))
) STRICT;
