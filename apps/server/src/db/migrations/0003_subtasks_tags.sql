CREATE TABLE `tag` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tag_name" CHECK(length(name) BETWEEN 1 AND 40)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_org_name` ON `tag` (`org_id`,"name" COLLATE NOCASE);--> statement-breakpoint
CREATE TABLE `task_expansion` (
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `task_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE TABLE `task_tag` (
	`task_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `tag_id`),
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `task_tag_tag` ON `task_tag` (`tag_id`);