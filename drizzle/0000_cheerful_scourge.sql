CREATE TABLE `achievement_unlocks` (
	`id` text PRIMARY KEY NOT NULL,
	`achievement_id` text NOT NULL,
	`unlocked_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`achievement_id`) REFERENCES `achievements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `achievement_unlock_unique_idx` ON `achievement_unlocks` (`achievement_id`);--> statement-breakpoint
CREATE TABLE `achievements` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`category` text NOT NULL,
	`threshold` integer NOT NULL,
	`icon` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "achievements_threshold_check" CHECK("achievements"."threshold" > 0)
);
--> statement-breakpoint
CREATE TABLE `ai_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT 'Primary AI' NOT NULL,
	`token_hash` text NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_tokens_hash_idx` ON `ai_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `app_settings` (
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
	CONSTRAINT "app_settings_singleton_check" CHECK("app_settings"."id" = 1),
	CONSTRAINT "app_settings_punishment_intensity_check" CHECK("app_settings"."punishment_intensity" between 0 and 3),
	CONSTRAINT "app_settings_daily_penalty_limit_check" CHECK("app_settings"."daily_penalty_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`summary` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	CONSTRAINT "audit_logs_actor_check" CHECK("audit_logs"."actor" in ('AI', 'user', 'system'))
);
--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_entity_idx` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `daily_activity` (
	`activity_date` text PRIMARY KEY NOT NULL,
	`completed_count` integer DEFAULT 0 NOT NULL,
	`streak_length` integer DEFAULT 0 NOT NULL,
	`streak_bonus` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	CONSTRAINT "daily_activity_completed_count_check" CHECK("daily_activity"."completed_count" >= 0),
	CONSTRAINT "daily_activity_streak_length_check" CHECK("daily_activity"."streak_length" > 0),
	CONSTRAINT "daily_activity_streak_bonus_check" CHECK("daily_activity"."streak_bonus" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`response` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `point_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`amount` integer NOT NULL,
	`task_id` text,
	`redemption_id` text,
	`idempotency_key` text NOT NULL,
	`reason` text NOT NULL,
	`effective_date` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`redemption_id`) REFERENCES `redemptions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "point_ledger_type_check" CHECK("point_ledger"."type" in ('task_reward', 'streak_bonus', 'task_penalty', 'redemption', 'manual_bonus', 'manual_penalty', 'correction')),
	CONSTRAINT "point_ledger_amount_check" CHECK("point_ledger"."amount" <> 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `point_ledger_idempotency_idx` ON `point_ledger` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `point_ledger_effective_date_idx` ON `point_ledger` (`effective_date`);--> statement-breakpoint
CREATE INDEX `point_ledger_task_idx` ON `point_ledger` (`task_id`);--> statement-breakpoint
CREATE TABLE `proof_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`object_key` text NOT NULL,
	`preview_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `task_submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "proof_assets_size_check" CHECK("proof_assets"."size_bytes" > 0),
	CONSTRAINT "proof_assets_dimensions_check" CHECK("proof_assets"."width" > 0 and "proof_assets"."height" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proof_assets_object_key_idx` ON `proof_assets` (`object_key`);--> statement-breakpoint
CREATE INDEX `proof_assets_submission_idx` ON `proof_assets` (`submission_id`);--> statement-breakpoint
CREATE TABLE `redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`reward_item_id` text NOT NULL,
	`item_name_snapshot` text NOT NULL,
	`cost_snapshot` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`idempotency_key` text NOT NULL,
	`redeemed_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`fulfilled_at` integer,
	`fulfillment_note` text,
	FOREIGN KEY (`reward_item_id`) REFERENCES `reward_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "redemptions_status_check" CHECK("redemptions"."status" in ('pending', 'fulfilled', 'cancelled')),
	CONSTRAINT "redemptions_cost_check" CHECK("redemptions"."cost_snapshot" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `redemptions_idempotency_idx` ON `redemptions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `redemptions_status_idx` ON `redemptions` (`status`);--> statement-breakpoint
CREATE TABLE `reward_items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`cost` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	CONSTRAINT "reward_items_cost_check" CHECK("reward_items"."cost" > 0)
);
--> statement-breakpoint
CREATE INDEX `reward_items_active_idx` ON `reward_items` (`active`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`csrf_token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_idx` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `statistics` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`total_earned` integer DEFAULT 0 NOT NULL,
	`total_spent` integer DEFAULT 0 NOT NULL,
	`total_penalties` integer DEFAULT 0 NOT NULL,
	`current_streak` integer DEFAULT 0 NOT NULL,
	`longest_streak` integer DEFAULT 0 NOT NULL,
	`total_active_days` integer DEFAULT 0 NOT NULL,
	`total_completed_tasks` integer DEFAULT 0 NOT NULL,
	`by_type` text DEFAULT '{}' NOT NULL,
	`by_difficulty` text DEFAULT '{}' NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	CONSTRAINT "statistics_singleton_check" CHECK("statistics"."id" = 1),
	CONSTRAINT "statistics_nonnegative_totals_check" CHECK("statistics"."balance" >= 0 and "statistics"."total_earned" >= 0 and "statistics"."total_spent" >= 0 and "statistics"."total_penalties" >= 0 and "statistics"."current_streak" >= 0 and "statistics"."longest_streak" >= 0 and "statistics"."total_active_days" >= 0 and "statistics"."total_completed_tasks" >= 0)
);
--> statement-breakpoint
CREATE TABLE `task_series` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`difficulty` text NOT NULL,
	`base_points` integer NOT NULL,
	`verification_mode` text NOT NULL,
	`proof_requirement` text NOT NULL,
	`recurrence` text DEFAULT 'daily' NOT NULL,
	`start_date` text NOT NULL,
	`next_occurrence_date` text DEFAULT (date('now')) NOT NULL,
	`end_date` text,
	`daily_deadline_time` text DEFAULT '23:59' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_by` text DEFAULT 'AI' NOT NULL,
	`related_task_id` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	CONSTRAINT "task_series_difficulty_check" CHECK("task_series"."difficulty" in ('easy', 'medium', 'hard')),
	CONSTRAINT "task_series_verification_mode_check" CHECK("task_series"."verification_mode" in ('self', 'ai_review')),
	CONSTRAINT "task_series_proof_requirement_check" CHECK("task_series"."proof_requirement" in ('none', 'text', 'image', 'text_or_image', 'text_and_image')),
	CONSTRAINT "task_series_recurrence_check" CHECK("task_series"."recurrence" in ('once', 'daily')),
	CONSTRAINT "task_series_created_by_check" CHECK("task_series"."created_by" in ('AI', 'user', 'system')),
	CONSTRAINT "task_series_base_points_check" CHECK("task_series"."base_points" > 0)
);
--> statement-breakpoint
CREATE INDEX `task_series_active_idx` ON `task_series` (`active`);--> statement-breakpoint
CREATE TABLE `task_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`proof_text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`submitted_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`reviewed_at` integer,
	`review_reason` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "submissions_status_check" CHECK("task_submissions"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "submissions_attempt_check" CHECK("task_submissions"."attempt" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submissions_task_attempt_idx` ON `task_submissions` (`task_id`,`attempt`);--> statement-breakpoint
CREATE INDEX `submissions_status_idx` ON `task_submissions` (`status`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`series_id` text,
	`occurrence_date` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`difficulty` text NOT NULL,
	`base_points` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`verification_mode` text NOT NULL,
	`proof_requirement` text NOT NULL,
	`created_by` text DEFAULT 'AI' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`related_task_id` text,
	`reveal_mode` text DEFAULT 'immediate' NOT NULL,
	`visible_at` integer,
	`revealed_at` integer,
	`deadline_at` integer,
	`submitted_at` integer,
	`completed_at` integer,
	`completion_date` text,
	`expired_at` integer,
	`failure_reason` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `task_series`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tasks_type_check" CHECK("tasks"."type" in ('daily', 'challenge', 'surprise')),
	CONSTRAINT "tasks_difficulty_check" CHECK("tasks"."difficulty" in ('easy', 'medium', 'hard')),
	CONSTRAINT "tasks_status_check" CHECK("tasks"."status" in ('pending', 'submitted', 'completed', 'failed', 'expired', 'cancelled')),
	CONSTRAINT "tasks_verification_mode_check" CHECK("tasks"."verification_mode" in ('self', 'ai_review')),
	CONSTRAINT "tasks_proof_requirement_check" CHECK("tasks"."proof_requirement" in ('none', 'text', 'image', 'text_or_image', 'text_and_image')),
	CONSTRAINT "tasks_created_by_check" CHECK("tasks"."created_by" in ('AI', 'user', 'system')),
	CONSTRAINT "tasks_reveal_mode_check" CHECK("tasks"."reveal_mode" in ('immediate', 'next_visit', 'at_time')),
	CONSTRAINT "tasks_base_points_check" CHECK("tasks"."base_points" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_series_occurrence_idx` ON `tasks` (`series_id`,`occurrence_date`);--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_deadline_idx` ON `tasks` (`deadline_at`);--> statement-breakpoint
CREATE INDEX `tasks_completion_date_idx` ON `tasks` (`completion_date`);--> statement-breakpoint
CREATE INDEX `tasks_visible_idx` ON `tasks` (`visible_at`);--> statement-breakpoint
CREATE TABLE `user_account` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`password_hash` text NOT NULL,
	`password_changed_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	CONSTRAINT "user_account_singleton_check" CHECK("user_account"."id" = 1)
);
