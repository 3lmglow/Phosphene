ALTER TABLE `user_account` ADD `recovery_question` text;--> statement-breakpoint
ALTER TABLE `user_account` ADD `recovery_answer_hash` text;--> statement-breakpoint
ALTER TABLE `user_account` ADD `recovery_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_account` ADD `recovery_window_started_at` integer;