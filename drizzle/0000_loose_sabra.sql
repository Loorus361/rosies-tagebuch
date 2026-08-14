CREATE TABLE `feed_items` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_feed_items_owner_created` ON `feed_items` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_feed_items_owner_name` ON `feed_items` (`owner_id`,`name`);--> statement-breakpoint
CREATE TABLE `feeding_day_items` (
	`day_id` text NOT NULL,
	`feed_item_id` text NOT NULL,
	`item_name` text NOT NULL,
	`feed_kind` text NOT NULL,
	`target_grams` real NOT NULL,
	PRIMARY KEY(`day_id`, `feed_item_id`),
	FOREIGN KEY (`day_id`) REFERENCES `feeding_days`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `feeding_days` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`plan_date` text NOT NULL,
	`source_plan_version_id` text,
	`meal_count` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_plan_version_id`) REFERENCES `plan_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_feeding_days_owner_date` ON `feeding_days` (`owner_id`,`plan_date`);--> statement-breakpoint
CREATE TABLE `meal_allocations` (
	`meal_id` text NOT NULL,
	`feed_item_id` text NOT NULL,
	`item_name` text NOT NULL,
	`feed_kind` text NOT NULL,
	`planned_grams` real NOT NULL,
	`actual_grams` real,
	PRIMARY KEY(`meal_id`, `feed_item_id`),
	FOREIGN KEY (`meal_id`) REFERENCES `meal_records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_meal_allocations_feed_item` ON `meal_allocations` (`feed_item_id`);--> statement-breakpoint
CREATE TABLE `meal_records` (
	`id` text PRIMARY KEY NOT NULL,
	`day_id` text NOT NULL,
	`meal_number` integer NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`day_id`) REFERENCES `feeding_days`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_meal_records_day_number` ON `meal_records` (`day_id`,`meal_number`);--> statement-breakpoint
CREATE TABLE `plan_version_items` (
	`plan_version_id` text NOT NULL,
	`feed_item_id` text NOT NULL,
	`daily_grams` real NOT NULL,
	PRIMARY KEY(`plan_version_id`, `feed_item_id`),
	FOREIGN KEY (`plan_version_id`) REFERENCES `plan_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feed_item_id`) REFERENCES `feed_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `plan_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`effective_date` text NOT NULL,
	`meal_count` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_plan_versions_owner_effective` ON `plan_versions` (`owner_id`,`effective_date`,`created_at`);--> statement-breakpoint
PRAGMA optimize;
