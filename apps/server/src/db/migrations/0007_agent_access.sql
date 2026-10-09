CREATE TABLE `access_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`client_id` text,
	`label` text NOT NULL,
	`scopes` text NOT NULL,
	`constraints` text DEFAULT '{"orgs":"all"}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`last_used_at` integer,
	`last_used_ip` text,
	`created_by_grant_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "access_grant_kind" CHECK(kind IN ('pat','device','oauth'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `access_grant_user` ON `access_grant` (`user_id`) WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `access_grant_oauth` ON `access_grant` (`user_id`,`client_id`) WHERE kind = 'oauth' AND revoked_at IS NULL;--> statement-breakpoint
CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text DEFAULT 'default' NOT NULL,
	`name` text,
	`start` text,
	`reference_id` text NOT NULL,
	`prefix` text,
	`key` text NOT NULL,
	`refill_interval` integer,
	`refill_amount` integer,
	`last_refill_at` integer,
	`enabled` integer DEFAULT true,
	`rate_limit_enabled` integer DEFAULT true,
	`rate_limit_time_window` integer,
	`rate_limit_max` integer,
	`request_count` integer DEFAULT 0,
	`remaining` integer,
	`last_request` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`permissions` text,
	`metadata` text,
	FOREIGN KEY (`reference_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `apikey_config` ON `apikey` (`config_id`);--> statement-breakpoint
CREATE INDEX `apikey_reference` ON `apikey` (`reference_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `apikey_key` ON `apikey` (`key`);--> statement-breakpoint
CREATE TABLE `deviceCode` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`last_polled_at` integer,
	`polling_interval` integer,
	`client_id` text,
	`scope` text,
	`grant_id` text,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_code_device_code` ON `deviceCode` (`device_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_code_user_code` ON `deviceCode` (`user_code`);--> statement-breakpoint
ALTER TABLE `session` ADD `grant_id` text;--> statement-breakpoint
CREATE INDEX `session_grant` ON `session` (`grant_id`);