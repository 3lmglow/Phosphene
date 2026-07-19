PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_app_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`initialized` integer DEFAULT false NOT NULL,
	`timezone` text DEFAULT 'Asia/Shanghai' NOT NULL,
	`user_label` text DEFAULT 'You' NOT NULL,
	`ai_label` text DEFAULT 'AI' NOT NULL,
	`allowed_content` text DEFAULT '[]' NOT NULL,
	`prohibited_content` text DEFAULT '[]' NOT NULL,
	`punishment_intensity` integer DEFAULT 0 NOT NULL,
	`daily_penalty_limit` integer DEFAULT 20 NOT NULL,
	`punishments_paused` integer DEFAULT false NOT NULL,
	`boundary_notes` text DEFAULT '' NOT NULL,
	`boundary_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	CONSTRAINT "app_settings_singleton_check" CHECK("__new_app_settings"."id" = 1),
	CONSTRAINT "app_settings_punishment_intensity_check" CHECK("__new_app_settings"."punishment_intensity" between 0 and 5),
	CONSTRAINT "app_settings_daily_penalty_limit_check" CHECK("__new_app_settings"."daily_penalty_limit" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_app_settings`("id", "initialized", "timezone", "user_label", "ai_label", "allowed_content", "prohibited_content", "punishment_intensity", "daily_penalty_limit", "punishments_paused", "boundary_notes", "boundary_version", "created_at", "updated_at") SELECT "id", "initialized", "timezone", "user_label", "ai_label", "allowed_content", "prohibited_content", "punishment_intensity", "daily_penalty_limit", "punishments_paused", "boundary_notes", "boundary_version", "created_at", "updated_at" FROM `app_settings`;--> statement-breakpoint
DROP TABLE `app_settings`;--> statement-breakpoint
ALTER TABLE `__new_app_settings` RENAME TO `app_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
