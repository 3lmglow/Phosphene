CREATE TYPE "public"."actor" AS ENUM('AI', 'user', 'system');--> statement-breakpoint
CREATE TYPE "public"."task_difficulty" AS ENUM('easy', 'medium', 'hard');--> statement-breakpoint
CREATE TYPE "public"."ledger_type" AS ENUM('task_reward', 'streak_bonus', 'task_penalty', 'redemption', 'manual_bonus', 'manual_penalty', 'correction');--> statement-breakpoint
CREATE TYPE "public"."proof_requirement" AS ENUM('none', 'text', 'image', 'text_or_image', 'text_and_image');--> statement-breakpoint
CREATE TYPE "public"."recurrence_mode" AS ENUM('once', 'daily');--> statement-breakpoint
CREATE TYPE "public"."redemption_status" AS ENUM('pending', 'fulfilled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."reveal_mode" AS ENUM('immediate', 'next_visit', 'at_time');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'submitted', 'completed', 'failed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('daily', 'challenge', 'surprise');--> statement-breakpoint
CREATE TYPE "public"."verification_mode" AS ENUM('self', 'ai_review');--> statement-breakpoint
CREATE TABLE "achievement_unlocks" (
	"id" text PRIMARY KEY NOT NULL,
	"achievement_id" text NOT NULL,
	"unlocked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "achievements" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"threshold" integer NOT NULL,
	"icon" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Primary AI' NOT NULL,
	"token_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"initialized" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"user_label" text DEFAULT 'You' NOT NULL,
	"ai_label" text DEFAULT 'AI' NOT NULL,
	"allowed_content" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prohibited_content" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"punishment_intensity" integer DEFAULT 0 NOT NULL,
	"daily_penalty_limit" integer DEFAULT 20 NOT NULL,
	"punishments_paused" boolean DEFAULT false NOT NULL,
	"boundary_notes" text DEFAULT '' NOT NULL,
	"boundary_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"actor" "actor" NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"summary" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_activity" (
	"activity_date" date PRIMARY KEY NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"streak_length" integer DEFAULT 0 NOT NULL,
	"streak_bonus" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "point_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "ledger_type" NOT NULL,
	"amount" integer NOT NULL,
	"task_id" text,
	"redemption_id" text,
	"idempotency_key" text NOT NULL,
	"reason" text NOT NULL,
	"effective_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proof_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"object_key" text NOT NULL,
	"preview_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redemptions" (
	"id" text PRIMARY KEY NOT NULL,
	"reward_item_id" text NOT NULL,
	"item_name_snapshot" text NOT NULL,
	"cost_snapshot" integer NOT NULL,
	"status" "redemption_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fulfilled_at" timestamp with time zone,
	"fulfillment_note" text
);
--> statement-breakpoint
CREATE TABLE "reward_items" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"cost" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statistics" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"total_earned" integer DEFAULT 0 NOT NULL,
	"total_spent" integer DEFAULT 0 NOT NULL,
	"total_penalties" integer DEFAULT 0 NOT NULL,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"longest_streak" integer DEFAULT 0 NOT NULL,
	"total_active_days" integer DEFAULT 0 NOT NULL,
	"total_completed_tasks" integer DEFAULT 0 NOT NULL,
	"by_type" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"by_difficulty" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_series" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"difficulty" "task_difficulty" NOT NULL,
	"base_points" integer NOT NULL,
	"verification_mode" "verification_mode" NOT NULL,
	"proof_requirement" "proof_requirement" NOT NULL,
	"recurrence" "recurrence_mode" DEFAULT 'daily' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"daily_deadline_time" text DEFAULT '23:59' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" "actor" DEFAULT 'AI' NOT NULL,
	"related_task_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"proof_text" text DEFAULT '' NOT NULL,
	"status" "submission_status" DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"review_reason" text
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"series_id" text,
	"occurrence_date" date,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" "task_type" NOT NULL,
	"difficulty" "task_difficulty" NOT NULL,
	"base_points" integer NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"verification_mode" "verification_mode" NOT NULL,
	"proof_requirement" "proof_requirement" NOT NULL,
	"created_by" "actor" DEFAULT 'AI' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"related_task_id" text,
	"reveal_mode" "reveal_mode" DEFAULT 'immediate' NOT NULL,
	"visible_at" timestamp with time zone,
	"revealed_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completion_date" date,
	"expired_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_account" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"password_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "achievement_unlocks" ADD CONSTRAINT "achievement_unlocks_achievement_id_achievements_id_fk" FOREIGN KEY ("achievement_id") REFERENCES "public"."achievements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "point_ledger" ADD CONSTRAINT "point_ledger_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "point_ledger" ADD CONSTRAINT "point_ledger_redemption_id_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."redemptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_assets" ADD CONSTRAINT "proof_assets_submission_id_task_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."task_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_reward_item_id_reward_items_id_fk" FOREIGN KEY ("reward_item_id") REFERENCES "public"."reward_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_submissions" ADD CONSTRAINT "task_submissions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_series_id_task_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."task_series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "achievement_unlock_unique_idx" ON "achievement_unlocks" USING btree ("achievement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_tokens_hash_idx" ON "ai_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "point_ledger_idempotency_idx" ON "point_ledger" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "point_ledger_effective_date_idx" ON "point_ledger" USING btree ("effective_date");--> statement-breakpoint
CREATE INDEX "point_ledger_task_idx" ON "point_ledger" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proof_assets_object_key_idx" ON "proof_assets" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "proof_assets_submission_idx" ON "proof_assets" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "redemptions_idempotency_idx" ON "redemptions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "redemptions_status_idx" ON "redemptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reward_items_active_idx" ON "reward_items" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "task_series_active_idx" ON "task_series" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_task_attempt_idx" ON "task_submissions" USING btree ("task_id","attempt");--> statement-breakpoint
CREATE INDEX "submissions_status_idx" ON "task_submissions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_series_occurrence_idx" ON "tasks" USING btree ("series_id","occurrence_date");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_deadline_idx" ON "tasks" USING btree ("deadline_at");--> statement-breakpoint
CREATE INDEX "tasks_completion_date_idx" ON "tasks" USING btree ("completion_date");--> statement-breakpoint
CREATE INDEX "tasks_visible_idx" ON "tasks" USING btree ("visible_at");