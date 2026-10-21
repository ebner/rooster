ALTER TABLE `access_grant` ADD `audience` text;--> statement-breakpoint
ALTER TABLE `deviceCode` ADD `oauth_client_id` text;--> statement-breakpoint
ALTER TABLE `deviceCode` ADD `resource` text;--> statement-breakpoint
ALTER TABLE `deviceCode` ADD `request_ip` text;--> statement-breakpoint
ALTER TABLE `deviceCode` ADD `created_at` integer;--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `successor_id` text;--> statement-breakpoint
ALTER TABLE `oauthRefreshToken` ADD `grace_used_at` integer;