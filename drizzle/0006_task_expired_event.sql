PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_domain_events` (
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
	CONSTRAINT "domain_events_type_check" CHECK("__new_domain_events"."type" in ('task.submitted', 'task.completed', 'task.expired', 'redemption.created', 'notification.test')),
	CONSTRAINT "domain_events_actor_check" CHECK("__new_domain_events"."actor" in ('AI', 'user', 'system')),
	CONSTRAINT "domain_events_version_check" CHECK("__new_domain_events"."version" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_domain_events`("sequence", "id", "type", "aggregate_type", "aggregate_id", "actor", "version", "payload", "dedupe_key", "created_at") SELECT "sequence", "id", "type", "aggregate_type", "aggregate_id", "actor", "version", "payload", "dedupe_key", "created_at" FROM `domain_events`;--> statement-breakpoint
DROP TABLE `domain_events`;--> statement-breakpoint
ALTER TABLE `__new_domain_events` RENAME TO `domain_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `domain_events_id_idx` ON `domain_events` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `domain_events_dedupe_idx` ON `domain_events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `domain_events_type_sequence_idx` ON `domain_events` (`type`,`sequence`);--> statement-breakpoint
CREATE INDEX `domain_events_aggregate_idx` ON `domain_events` (`aggregate_type`,`aggregate_id`);--> statement-breakpoint
CREATE TABLE `__new_webhook_config` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`event_types` text DEFAULT '["task.submitted","task.completed","task.expired","redemption.created"]' NOT NULL,
	`signing_secret` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	CONSTRAINT "webhook_config_singleton_check" CHECK("__new_webhook_config"."id" = 1)
);
--> statement-breakpoint
INSERT INTO `__new_webhook_config`("id", "enabled", "url", "event_types", "signing_secret", "created_at", "updated_at") SELECT "id", "enabled", "url", "event_types", "signing_secret", "created_at", "updated_at" FROM `webhook_config`;--> statement-breakpoint
DROP TABLE `webhook_config`;--> statement-breakpoint
ALTER TABLE `__new_webhook_config` RENAME TO `webhook_config`;--> statement-breakpoint
UPDATE `webhook_config` SET `event_types` = json_insert(`event_types`, '$[#]', 'task.expired') WHERE json_valid(`event_types`) AND NOT EXISTS (SELECT 1 FROM json_each(`webhook_config`.`event_types`) WHERE value = 'task.expired');
