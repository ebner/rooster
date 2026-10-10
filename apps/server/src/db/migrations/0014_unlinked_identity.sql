CREATE TABLE `unlinked_identity` (
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`account_id` text NOT NULL,
	`email` text,
	`unlinked_at` integer NOT NULL,
	PRIMARY KEY(`provider_id`, `account_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `unlinked_identity_id` ON `unlinked_identity` (`id`);--> statement-breakpoint
CREATE INDEX `unlinked_identity_user` ON `unlinked_identity` (`user_id`);