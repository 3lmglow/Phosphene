import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type {
  ACTORS,
  PROOF_REQUIREMENTS,
  RECURRENCE_MODES,
  REVEAL_MODES,
  TASK_DIFFICULTIES,
  TASK_STATUSES,
  TASK_TYPES,
  VERIFICATION_MODES
} from "../../shared/constants";

export type TaskType = (typeof TASK_TYPES)[number];
export type TaskDifficulty = (typeof TASK_DIFFICULTIES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type VerificationMode = (typeof VERIFICATION_MODES)[number];
export type ProofRequirement = (typeof PROOF_REQUIREMENTS)[number];
export type RecurrenceMode = (typeof RECURRENCE_MODES)[number];
export type RevealMode = (typeof REVEAL_MODES)[number];
export type Actor = (typeof ACTORS)[number];

export const taskTypeEnum = pgEnum("task_type", ["daily", "challenge", "surprise"]);
export const difficultyEnum = pgEnum("task_difficulty", ["easy", "medium", "hard"]);
export const taskStatusEnum = pgEnum("task_status", [
  "pending",
  "submitted",
  "completed",
  "failed",
  "expired",
  "cancelled"
]);
export const verificationModeEnum = pgEnum("verification_mode", ["self", "ai_review"]);
export const proofRequirementEnum = pgEnum("proof_requirement", [
  "none",
  "text",
  "image",
  "text_or_image",
  "text_and_image"
]);
export const recurrenceEnum = pgEnum("recurrence_mode", ["once", "daily"]);
export const revealModeEnum = pgEnum("reveal_mode", ["immediate", "next_visit", "at_time"]);
export const actorEnum = pgEnum("actor", ["AI", "user", "system"]);
export const submissionStatusEnum = pgEnum("submission_status", ["pending", "approved", "rejected"]);
export const ledgerTypeEnum = pgEnum("ledger_type", [
  "task_reward",
  "streak_bonus",
  "task_penalty",
  "redemption",
  "manual_bonus",
  "manual_penalty",
  "correction"
]);
export const redemptionStatusEnum = pgEnum("redemption_status", ["pending", "fulfilled", "cancelled"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
};

export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  initialized: boolean("initialized").notNull().default(false),
  timezone: text("timezone").notNull().default("Asia/Shanghai"),
  userLabel: text("user_label").notNull().default("You"),
  aiLabel: text("ai_label").notNull().default("AI"),
  allowedContent: jsonb("allowed_content").$type<string[]>().notNull().default([]),
  prohibitedContent: jsonb("prohibited_content").$type<string[]>().notNull().default([]),
  punishmentIntensity: integer("punishment_intensity").notNull().default(0),
  dailyPenaltyLimit: integer("daily_penalty_limit").notNull().default(20),
  punishmentsPaused: boolean("punishments_paused").notNull().default(false),
  boundaryNotes: text("boundary_notes").notNull().default(""),
  boundaryVersion: integer("boundary_version").notNull().default(1),
  ...timestamps
});

export const userAccount = pgTable("user_account", {
  id: integer("id").primaryKey().default(1),
  passwordHash: text("password_hash").notNull(),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("sessions_token_hash_idx").on(table.tokenHash), index("sessions_expiry_idx").on(table.expiresAt)]
);

export const aiTokens = pgTable(
  "ai_tokens",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().default("Primary AI"),
    tokenHash: text("token_hash").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("ai_tokens_hash_idx").on(table.tokenHash)]
);

export const taskSeries = pgTable(
  "task_series",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    difficulty: difficultyEnum("difficulty").notNull(),
    basePoints: integer("base_points").notNull(),
    verificationMode: verificationModeEnum("verification_mode").notNull(),
    proofRequirement: proofRequirementEnum("proof_requirement").notNull(),
    recurrence: recurrenceEnum("recurrence").notNull().default("daily"),
    startDate: date("start_date").notNull(),
    nextOccurrenceDate: date("next_occurrence_date").notNull().default(sql`current_date`),
    endDate: date("end_date"),
    dailyDeadlineTime: text("daily_deadline_time").notNull().default("23:59"),
    active: boolean("active").notNull().default(true),
    createdBy: actorEnum("created_by").notNull().default("AI"),
    relatedTaskId: text("related_task_id"),
    ...timestamps
  },
  (table) => [index("task_series_active_idx").on(table.active)]
);

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    seriesId: text("series_id").references(() => taskSeries.id, { onDelete: "set null" }),
    occurrenceDate: date("occurrence_date"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    type: taskTypeEnum("type").notNull(),
    difficulty: difficultyEnum("difficulty").notNull(),
    basePoints: integer("base_points").notNull(),
    status: taskStatusEnum("status").notNull().default("pending"),
    verificationMode: verificationModeEnum("verification_mode").notNull(),
    proofRequirement: proofRequirementEnum("proof_requirement").notNull(),
    createdBy: actorEnum("created_by").notNull().default("AI"),
    source: text("source").notNull().default("manual"),
    relatedTaskId: text("related_task_id"),
    revealMode: revealModeEnum("reveal_mode").notNull().default("immediate"),
    visibleAt: timestamp("visible_at", { withTimezone: true }),
    revealedAt: timestamp("revealed_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completionDate: date("completion_date"),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    ...timestamps
  },
  (table) => [
    uniqueIndex("tasks_series_occurrence_idx").on(table.seriesId, table.occurrenceDate),
    index("tasks_status_idx").on(table.status),
    index("tasks_deadline_idx").on(table.deadlineAt),
    index("tasks_completion_date_idx").on(table.completionDate),
    index("tasks_visible_idx").on(table.visibleAt)
  ]
);

export const taskSubmissions = pgTable(
  "task_submissions",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull().default(1),
    proofText: text("proof_text").notNull().default(""),
    status: submissionStatusEnum("status").notNull().default("pending"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewReason: text("review_reason")
  },
  (table) => [
    uniqueIndex("submissions_task_attempt_idx").on(table.taskId, table.attempt),
    index("submissions_status_idx").on(table.status)
  ]
);

export const proofAssets = pgTable(
  "proof_assets",
  {
    id: text("id").primaryKey(),
    submissionId: text("submission_id")
      .notNull()
      .references(() => taskSubmissions.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull(),
    previewKey: text("preview_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("proof_assets_object_key_idx").on(table.objectKey), index("proof_assets_submission_idx").on(table.submissionId)]
);

export const rewardItems = pgTable(
  "reward_items",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    cost: integer("cost").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps
  },
  (table) => [index("reward_items_active_idx").on(table.active)]
);

export const redemptions = pgTable(
  "redemptions",
  {
    id: text("id").primaryKey(),
    rewardItemId: text("reward_item_id")
      .notNull()
      .references(() => rewardItems.id),
    itemNameSnapshot: text("item_name_snapshot").notNull(),
    costSnapshot: integer("cost_snapshot").notNull(),
    status: redemptionStatusEnum("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    fulfillmentNote: text("fulfillment_note")
  },
  (table) => [uniqueIndex("redemptions_idempotency_idx").on(table.idempotencyKey), index("redemptions_status_idx").on(table.status)]
);

export const pointLedger = pgTable(
  "point_ledger",
  {
    id: text("id").primaryKey(),
    type: ledgerTypeEnum("type").notNull(),
    amount: integer("amount").notNull(),
    taskId: text("task_id").references(() => tasks.id),
    redemptionId: text("redemption_id").references(() => redemptions.id),
    idempotencyKey: text("idempotency_key").notNull(),
    reason: text("reason").notNull(),
    effectiveDate: date("effective_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("point_ledger_idempotency_idx").on(table.idempotencyKey),
    index("point_ledger_effective_date_idx").on(table.effectiveDate),
    index("point_ledger_task_idx").on(table.taskId)
  ]
);

export const dailyActivity = pgTable("daily_activity", {
  activityDate: date("activity_date").primaryKey(),
  completedCount: integer("completed_count").notNull().default(0),
  streakLength: integer("streak_length").notNull().default(0),
  streakBonus: integer("streak_bonus").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const statistics = pgTable("statistics", {
  id: integer("id").primaryKey().default(1),
  balance: integer("balance").notNull().default(0),
  totalEarned: integer("total_earned").notNull().default(0),
  totalSpent: integer("total_spent").notNull().default(0),
  totalPenalties: integer("total_penalties").notNull().default(0),
  currentStreak: integer("current_streak").notNull().default(0),
  longestStreak: integer("longest_streak").notNull().default(0),
  totalActiveDays: integer("total_active_days").notNull().default(0),
  totalCompletedTasks: integer("total_completed_tasks").notNull().default(0),
  byType: jsonb("by_type").$type<Record<string, number>>().notNull().default({}),
  byDifficulty: jsonb("by_difficulty").$type<Record<string, number>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const achievements = pgTable("achievements", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  threshold: integer("threshold").notNull(),
  icon: text("icon").notNull(),
  sortOrder: integer("sort_order").notNull().default(0)
});

export const achievementUnlocks = pgTable(
  "achievement_unlocks",
  {
    id: text("id").primaryKey(),
    achievementId: text("achievement_id")
      .notNull()
      .references(() => achievements.id),
    unlockedAt: timestamp("unlocked_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("achievement_unlock_unique_idx").on(table.achievementId)]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    actor: actorEnum("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("audit_logs_created_idx").on(table.createdAt), index("audit_logs_entity_idx").on(table.entityType, table.entityId)]
);

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  operation: text("operation").notNull(),
  response: jsonb("response").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const taskRelations = relations(tasks, ({ one, many }) => ({
  series: one(taskSeries, { fields: [tasks.seriesId], references: [taskSeries.id] }),
  submissions: many(taskSubmissions)
}));

export const taskSeriesRelations = relations(taskSeries, ({ many }) => ({
  tasks: many(tasks)
}));

export const taskSubmissionRelations = relations(taskSubmissions, ({ one, many }) => ({
  task: one(tasks, { fields: [taskSubmissions.taskId], references: [tasks.id] }),
  assets: many(proofAssets)
}));

export const proofAssetRelations = relations(proofAssets, ({ one }) => ({
  submission: one(taskSubmissions, { fields: [proofAssets.submissionId], references: [taskSubmissions.id] })
}));

export const rewardItemRelations = relations(rewardItems, ({ many }) => ({
  redemptions: many(redemptions)
}));

export const redemptionRelations = relations(redemptions, ({ one }) => ({
  rewardItem: one(rewardItems, { fields: [redemptions.rewardItemId], references: [rewardItems.id] })
}));

export const achievementRelations = relations(achievements, ({ many }) => ({
  unlocks: many(achievementUnlocks)
}));

export const achievementUnlockRelations = relations(achievementUnlocks, ({ one }) => ({
  achievement: one(achievements, {
    fields: [achievementUnlocks.achievementId],
    references: [achievements.id]
  })
}));

export type TaskRow = typeof tasks.$inferSelect;
export type SubmissionRow = typeof taskSubmissions.$inferSelect;
export type SettingsRow = typeof appSettings.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
