CREATE TABLE `task_former_seq` (
	`org_id` text NOT NULL,
	`seq` integer NOT NULL,
	`task_id` text NOT NULL,
	`moved_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `seq`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `task_former_seq_task` ON `task_former_seq` (`task_id`,`org_id`);