CREATE TABLE `saved_view` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_by` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`query` text NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "saved_view_name" CHECK(length(name) BETWEEN 1 AND 60)
) STRICT;
--> statement-breakpoint
CREATE INDEX `saved_view_org` ON `saved_view` (`org_id`,`created_by`);--> statement-breakpoint
CREATE TABLE `saved_view_pref` (
	`user_id` text NOT NULL,
	`view_id` text NOT NULL,
	`position` text NOT NULL,
	PRIMARY KEY(`user_id`, `view_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`view_id`) REFERENCES `saved_view`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `saved_view_pref_view` ON `saved_view_pref` (`view_id`);