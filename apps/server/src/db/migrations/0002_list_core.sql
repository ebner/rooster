CREATE TABLE `idempotency` (
	`op_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` integer NOT NULL,
	`response` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`op_id`, `user_id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `placement` (
	`task_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`group_id` text NOT NULL,
	`position` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `task_group`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `placement_list` ON `placement` (`user_id`,`org_id`,`group_id`,`position`);--> statement-breakpoint
CREATE TABLE `task` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`seq` integer,
	`parent_id` text,
	`subtask_position` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`assignee_id` text,
	`created_by` text NOT NULL,
	`due_date` text,
	`due_time` text,
	`due_tz` text,
	`start_date` text,
	`recurrence` text,
	`recurrence_basis` text,
	`series_id` text,
	`completed_at` integer,
	`completed_by` text,
	`field_clock` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`completed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deleted_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_title" CHECK(length(title) BETWEEN 1 AND 500),
	CONSTRAINT "task_recurrence_basis" CHECK(recurrence_basis IS NULL OR recurrence_basis IN ('due','completion')),
	CONSTRAINT "task_due_time_needs_date" CHECK(due_time IS NULL OR due_date IS NOT NULL),
	CONSTRAINT "task_start_before_due" CHECK(start_date IS NULL OR due_date IS NULL OR start_date <= due_date),
	CONSTRAINT "task_parent_position" CHECK((parent_id IS NULL) = (subtask_position IS NULL))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `task_org_seq` ON `task` (`org_id`,`seq`);--> statement-breakpoint
CREATE INDEX `task_parent` ON `task` (`parent_id`,`subtask_position`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `task_assignee` ON `task` (`org_id`,`assignee_id`,`completed_at`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `task_due` ON `task` (`org_id`,`due_date`) WHERE deleted_at IS NULL AND completed_at IS NULL;--> statement-breakpoint
CREATE INDEX `task_trash` ON `task` (`org_id`,`deleted_at`) WHERE deleted_at IS NOT NULL;