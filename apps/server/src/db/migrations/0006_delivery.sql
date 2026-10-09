CREATE TABLE `job_run` (
	`job` text NOT NULL,
	`scope` text NOT NULL,
	`ran_at` integer NOT NULL,
	PRIMARY KEY(`job`, `scope`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `push_subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`last_ok_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscription_endpoint_unique` ON `push_subscription` (`endpoint`);--> statement-breakpoint
CREATE INDEX `notification_email_pending` ON `notification` (`user_id`,`created_at`) WHERE emailed_at IS NULL AND json_extract(data, '$.emailPending') = 1;