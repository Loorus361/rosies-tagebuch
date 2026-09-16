ALTER TABLE `feeding_day_items` ADD `calorie_percent` real;--> statement-breakpoint
ALTER TABLE `feeding_days` ADD `target_kcal` real;--> statement-breakpoint
ALTER TABLE `plan_version_items` ADD `calorie_percent` real;--> statement-breakpoint
ALTER TABLE `plan_versions` ADD `target_kcal` real;