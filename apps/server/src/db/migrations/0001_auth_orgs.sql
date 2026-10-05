CREATE TABLE `allowlist_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`value` text COLLATE NOCASE NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "allowlist_entry_kind" CHECK(kind IN ('email','domain'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `allowlist_entry_value_unique` ON `allowlist_entry` (`value`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user` ON `account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_account` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`week_start` integer DEFAULT 1 NOT NULL,
	`date_format` text DEFAULT 'MMM d' NOT NULL,
	`time_format` text DEFAULT '24h' NOT NULL,
	`prefs` text DEFAULT '{}' NOT NULL,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`inviter_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invitation_role" CHECK(role IN ('owner','member')),
	CONSTRAINT "invitation_status" CHECK(status IN ('pending','accepted','canceled','rejected'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `invitation_org` ON `invitation` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `invitation_email` ON `invitation` (`email`,`status`);--> statement-breakpoint
CREATE TABLE `invite_link` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`role` text NOT NULL,
	`multi_use` integer DEFAULT false NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invite_link_role" CHECK(role IN ('owner','member'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_link_token_hash_unique` ON `invite_link` (`token_hash`);--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "member_role" CHECK(role IN ('owner','member'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `member_org_user` ON `member` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `member_user` ON `member` (`user_id`);--> statement-breakpoint
CREATE TABLE `org_member_pref` (
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`position` text NOT NULL,
	`collapsed` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`user_id`, `org_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`is_personal` integer DEFAULT false NOT NULL,
	`avatar_emoji` text,
	`color` text,
	`task_seq` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug` ON `organization` (`slug`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE TABLE `task_group` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text DEFAULT 'normal' NOT NULL,
	`name` text NOT NULL,
	`position` text NOT NULL,
	`collapsed` integer DEFAULT false NOT NULL,
	`field_clock` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_group_kind" CHECK(kind IN ('inbox','normal')),
	CONSTRAINT "task_group_name" CHECK(length(name) BETWEEN 1 AND 80)
) STRICT;
--> statement-breakpoint
CREATE INDEX `task_group_owner` ON `task_group` (`user_id`,`org_id`,`position`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `task_group_one_inbox` ON `task_group` (`user_id`,`org_id`) WHERE kind = 'inbox';