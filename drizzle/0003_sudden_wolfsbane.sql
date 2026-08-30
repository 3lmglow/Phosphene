CREATE TABLE `domain_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`type` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`actor` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`dedupe_key` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	CONSTRAINT "domain_events_type_check" CHECK("domain_events"."type" in ('task.submitted', 'task.completed', 'redemption.created', 'notification.test')),
	CONSTRAINT "domain_events_actor_check" CHECK("domain_events"."actor" in ('AI', 'user', 'system')),
	CONSTRAINT "domain_events_version_check" CHECK("domain_events"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_events_id_idx` ON `domain_events` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `domain_events_dedupe_idx` ON `domain_events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `domain_events_type_sequence_idx` ON `domain_events` (`type`,`sequence`);--> statement-breakpoint
CREATE INDEX `domain_events_aggregate_idx` ON `domain_events` (`aggregate_type`,`aggregate_id`);--> statement-breakpoint
CREATE TABLE `webhook_config` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`event_types` text DEFAULT '["task.submitted","task.completed","redemption.created"]' NOT NULL,
	`signing_secret` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	CONSTRAINT "webhook_config_singleton_check" CHECK("webhook_config"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`last_attempt_at` integer,
	`delivered_at` integer,
	`last_status_code` integer,
	`last_error` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `domain_events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "webhook_deliveries_status_check" CHECK("webhook_deliveries"."status" in ('pending', 'processing', 'delivered', 'dead_letter')),
	CONSTRAINT "webhook_deliveries_attempt_check" CHECK("webhook_deliveries"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_event_idx` ON `webhook_deliveries` (`event_id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_ready_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_lease_idx` ON `webhook_deliveries` (`status`,`lease_expires_at`);--> statement-breakpoint
ALTER TABLE `idempotency_keys` ADD `request_hash` text;