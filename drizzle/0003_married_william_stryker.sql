CREATE TABLE `agent_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_access_tokens_hash` ON `agent_access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_agent_access_tokens_owner_created` ON `agent_access_tokens` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_action_requests` (
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	PRIMARY KEY(`owner_id`, `idempotency_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_agent_action_requests_created` ON `agent_action_requests` (`created_at`);--> statement-breakpoint
ALTER TABLE `meal_records` ADD `recorded_via` text;