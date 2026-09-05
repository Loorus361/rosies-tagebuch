CREATE TABLE `feed_energy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`feed_item_id` text NOT NULL,
	`kcal_per_100g` real,
	`effective_date` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`feed_item_id`) REFERENCES `feed_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_feed_energy_owner_item_date` ON `feed_energy_versions` (`owner_id`,`feed_item_id`,`effective_date`,`created_at`);