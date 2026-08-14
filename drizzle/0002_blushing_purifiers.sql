CREATE TABLE `meal_medications` (
	`meal_id` text NOT NULL,
	`medication_id` text NOT NULL,
	`medication_name` text NOT NULL,
	`target_amount` text NOT NULL,
	`unit` text NOT NULL,
	`given_at` text,
	PRIMARY KEY(`meal_id`, `medication_id`),
	FOREIGN KEY (`meal_id`) REFERENCES `meal_records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `medications` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_medications_owner_created` ON `medications` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_medications_owner_name` ON `medications` (`owner_id`,`name`);--> statement-breakpoint
CREATE TABLE `plan_version_medication_doses` (
	`plan_version_id` text NOT NULL,
	`medication_id` text NOT NULL,
	`medication_name` text NOT NULL,
	`target_amount` text NOT NULL,
	`unit` text NOT NULL,
	`meal_number` integer NOT NULL,
	PRIMARY KEY(`plan_version_id`, `medication_id`, `meal_number`),
	FOREIGN KEY (`plan_version_id`) REFERENCES `plan_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`medication_id`) REFERENCES `medications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
PRAGMA optimize;
