import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";
import {
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

const SUBMISSION_STATUSES = ["pending", "approved", "rejected"] as const;
const LEDGER_TYPES = [
  "task_reward",
  "streak_bonus",
  "task_penalty",
  "redemption",
  "manual_bonus",
  "manual_penalty",
  "correction"
] as const;
const REDEMPTION_STATUSES = ["pending", "fulfilled", "cancelled"] as const;
const nowInMilliseconds = sql`(cast((julianday('now') - 2440587.5) * 86400000 as integer))`;
const jsonArray = sql`'[]'`;
const jsonObject = sql`'{}'`;

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(nowInMilliseconds),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(nowInMilliseconds)
};

export const appSettings = sqliteTable(
  "app_settings",
  {
    id: integer("id").primaryKey().default(1),
    initialized: integer("initialized", { mode: "boolean" }).notNull().default(false),
    timezone: text("timezone").notNull().default("Asia/Shanghai"),
    userLabel: text("user_label").notNull().default("You"),
    aiLabel: text("ai_label").notNull().default("AI"),
    allowedContent: text("allowed_content", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(jsonArray),
    prohibitedContent: text("prohibited_content", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(jsonArray),
    punishmentIntensity: integer("punishment_intensity").notNull().default(0),
    dailyPenaltyLimit: integer("daily_penalty_limit").notNull().default(20),
    punishmentsPaused: integer("punishments_paused", { mode: "boolean" })
      .notNull()
      .default(false),
    boundaryNotes: text("boundary_notes").notNull().default(""),
    boundaryVersion: integer("boundary_version").notNull().default(1),
    ...timestamps
  },
  (table) => [
    check(
      "app_settings_singleton_check",
      sql`${table.id} = 1`
    ),
    check(
      "app_settings_punishment_intensity_check",
      sql`${table.punishmentIntensity} between 0 and 3`
    ),
    check(
      "app_settings_daily_penalty_limit_check",
      sql`${table.dailyPenaltyLimit} >= 0`
    )
  ]
);

export const userAccount = sqliteTable(
  "user_account",
  {
    id: integer("id").primaryKey().default(1),
    passwordHash: text("password_hash").notNull(),
    passwordChangedAt: integer("password_changed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(nowInMilliseconds),
    ...timestamps
  },
  (table) => [check("user_account_singleton_check", sql`${table.id} = 1`)]
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
      .notNull()
      .default(nowInMilliseconds),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(nowInMilliseconds)
  },
  (table) => [
    uniqueIndex("sessions_token_hash_idx").on(table.tokenHash),
    index("sessions_expiry_idx").on(table.expiresAt)
  ]
);

export const aiTokens = sqliteTable(
  "ai_tokens",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().default("Primary AI"),
    tokenHash: text("token_hash").notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(nowInMilliseconds)
  },
  (table) => [uniqueIndex("ai_tokens_hash_idx").on(table.tokenHash)]
);

export const taskSeries = sqliteTable(
  "task_series",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    difficulty: text("difficulty", { enum: TASK_DIFFICULTIES }).notNull(),
    basePoints: integer("base_points").notNull(),
    verificationMode: text("verification_mode", { enum: VERIFICATION_MODES }).notNull(),
    proofRequirement: text("proof_requirement", { enum: PROOF_REQUIREMENTS }).notNull(),
    recurrence: text("recurrence", { enum: RECURRENCE_MODES }).notNull().default("daily"),
    startDate: text("start_date").notNull(),
    nextOccurrenceDate: text("next_occurrence_date")
      .notNull()
      .default(sql`(date('now'))`),
    endDate: text("end_date"),
    dailyDeadlineTime: text("daily_deadline_time").notNull().default("23:59"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by", { enum: ACTORS }).notNull().default("AI"),
    relatedTaskId: text("related_task_id"),
    ...timestamps
  },
  (table) => [
    index("task_series_active_idx").on(table.active),
    check(
      "task_series_difficulty_check",
      sql`${table.difficulty} in ('easy', 'medium', 'hard')`
    ),
    check(
      "task_series_verification_mode_check",
      sql`${table.verificationMode} in ('self', 'ai_review')`
    ),
    check(
      "task_series_proof_requirement_check",
      sql`${table.proofRequirement} in ('none', 'text', 'image', 'text_or_image', 'text_and_image')`
    ),
    check(
      "task_series_recurrence_check",
      sql`${table.recurrence} in ('once', 'daily')`
    ),
    check(
      "task_series_created_by_check",
      sql`${table.createdBy} in ('AI', 'user', 'system')`
    ),
    check("task_series_base_points_check", sql`${table.basePoints} > 0`)
  ]
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    seriesId: text("series_id").references(() => taskSeries.id, { onDelete: "set null" }),
    occurrenceDate: text("occurrence_date"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    type: text("type", { enum: TASK_TYPES }).notNull(),
    difficulty: text("difficulty", { enum: TASK_DIFFICULTIES }).notNull(),
    basePoints: integer("base_points").notNull(),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("pending"),
    verificationMode: text("verification_mode", { enum: VERIFICATION_MODES }).notNull(),
    proofRequirement: text("proof_requirement", { enum: PROOF_REQUIREMENTS }).notNull(),
    createdBy: text("created_by", { enum: ACTORS }).notNull().default("AI"),
    source: text("source").notNull().default("manual"),
    relatedTaskId: text("related_task_id"),
    revealMode: text("reveal_mode", { enum: REVEAL_MODES }).notNull().default("immediate"),
    visibleAt: integer("visible_at", { mode: "timestamp_ms" }),
    revealedAt: integer("revealed_at", { mode: "timestamp_ms" }),
    deadlineAt: integer("deadline_at", { mode: "timestamp_ms" }),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    completionDate: text("completion_date"),
    expiredAt: integer("expired_at", { mode: "timestamp_ms" }),
    failureReason: text("failure_reason"),
    ...timestamps
  },
  (table) => [
    uniqueIndex("tasks_series_occurrence_idx").on(table.seriesId, table.occurrenceDate),
    index("tasks_status_idx").on(table.status),
    index("tasks_deadline_idx").on(table.deadlineAt),
    index("tasks_completion_date_idx").on(table.completionDate),
    index("tasks_visible_idx").on(table.visibleAt),
    check("tasks_type_check", sql`${table.type} in ('daily', 'challenge', 'surprise')`),
    check(
      "tasks_difficulty_check",
      sql`${table.difficulty} in ('easy', 'medium', 'hard')`
    ),
    check(
      "tasks_status_check",
      sql`${table.status} in ('pending', 'submitted', 'completed', 'failed', 'expired', 'cancelled')`
    ),
    check(
      "tasks_verification_mode_check",
      sql`${table.verificationMode} in ('self', 'ai_review')`
    ),
    check(
      "tasks_proof_requirement_check",
      sql`${table.proofRequirement} in ('none', 'text', 'image', 'text_or_image', 'text_and_image')`
    ),
    check(
      "tasks_created_by_check",
      sql`${table.createdBy} in ('AI', 'user', 'system')`
    ),
    check(
      "tasks_reveal_mode_check",
      sql`${table.revealMode} in ('immediate', 'next_visit', 'at_time')`
    ),
    check("tasks_base_points_check", sql`${table.basePoints} > 0`)
  ]
);

export const taskSubmissions = sqliteTable(
  "task_submissions",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull().default(1),
    proofText: text("proof_text").notNull().default(""),
    status: text("status", { enum: SUBMISSION_STATUSES }).notNull().default("pending"),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" })
      .notNull()
      .default(nowInMilliseconds),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    reviewReason: text("review_reason")
  },
  (table) => [
    uniqueIndex("submissions_task_attempt_idx").on(table.taskId, table.attempt),
    index("submissions_status_idx").on(table.status),
    check(
      "submissions_status_check",
      sql`${table.status} in ('pending', 'approved', 'rejected')`
    ),
    check("submissions_attempt_check", sql`${table.attempt} > 0`)
  ]
);

export const proofAssets = sqliteTable(
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
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(nowInMilliseconds)
  },
  (table) => [
    uniqueIndex("proof_assets_object_key_idx").on(table.objectKey),
    index("proof_assets_submission_idx").on(table.submissionId),
    check("proof_assets_size_check", sql`${table.sizeBytes} > 0`),
    check("proof_assets_dimensions_check", sql`${table.width} > 0 and ${table.height} > 0`)
  ]
);

export const rewardItems = sqliteTable(
  "reward_items",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    cost: integer("cost").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps
  },
  (table) => [
    index("reward_items_active_idx").on(table.active),
    check("reward_items_cost_check", sql`${table.cost} > 0`)
  ]
);

export const redemptions = sqliteTable(
  "redemptions",
  {
    id: text("id").primaryKey(),
    rewardItemId: text("reward_item_id")
      .notNull()
      .references(() => rewardItems.id),
    itemNameSnapshot: text("item_name_snapshot").notNull(),
    costSnapshot: integer("cost_snapshot").notNull(),
    status: text("status", { enum: REDEMPTION_STATUSES }).notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    redeemedAt: integer("redeemed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(nowInMilliseconds),
    fulfilledAt: integer("fulfilled_at", { mode: "timestamp_ms" }),
    fulfillmentNote: text("fulfillment_note")
  },
  (table) => [
    uniqueIndex("redemptions_idempotency_idx").on(table.idempotencyKey),
    index("redemptions_status_idx").on(table.status),
    check(
      "redemptions_status_check",
      sql`${table.status} in ('pending', 'fulfilled', 'cancelled')`
    ),
    check("redemptions_cost_check", sql`${table.costSnapshot} > 0`)
  ]
);

export const pointLedger = sqliteTable(
  "point_ledger",
  {
    id: text("id").primaryKey(),
    type: text("type", { enum: LEDGER_TYPES }).notNull(),
    amount: integer("amount").notNull(),
    taskId: text("task_id").references(() => tasks.id),
    redemptionId: text("redemption_id").references(() => redemptions.id),
    idempotencyKey: text("idempotency_key").notNull(),
    reason: text("reason").notNull(),
    effectiveDate: text("effective_date"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(nowInMilliseconds)
  },
  (table) => [
    uniqueIndex("point_ledger_idempotency_idx").on(table.idempotencyKey),
    index("point_ledger_effective_date_idx").on(table.effectiveDate),
    index("point_ledger_task_idx").on(table.taskId),
    check(
      "point_ledger_type_check",
      sql`${table.type} in ('task_reward', 'streak_bonus', 'task_penalty', 'redemption', 'manual_bonus', 'manual_penalty', 'correction')`
    ),
    check("point_ledger_amount_check", sql`${table.amount} <> 0`)
  ]
);

export const dailyActivity = sqliteTable(
  "daily_activity",
  {
    activityDate: text("activity_date").primaryKey(),
    completedCount: integer("completed_count").notNull().default(0),
    streakLength: integer("streak_length").notNull().default(0),
    streakBonus: integer("streak_bonus").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(nowInMilliseconds)
  },
  (table) => [
    check("daily_activity_completed_count_check", sql`${table.completedCount} >= 0`),
    check("daily_activity_streak_length_check", sql`${table.streakLength} > 0`),
    check("daily_activity_streak_bonus_check", sql`${table.streakBonus} between 0 and 3`)
  ]
);

export const statistics = sqliteTable(
  "statistics",
  {
    id: integer("id").primaryKey().default(1),
    balance: integer("balance").notNull().default(0),
    totalEarned: integer("total_earned").notNull().default(0),
    totalSpent: integer("total_spent").notNull().default(0),
    totalPenalties: integer("total_penalties").notNull().default(0),
    currentStreak: integer("current_streak").notNull().default(0),
    longestStreak: integer("longest_streak").notNull().default(0),
    totalActiveDays: integer("total_active_days").notNull().default(0),
    totalCompletedTasks: integer("total_completed_tasks").notNull().default(0),
    byType: text("by_type", { mode: "json" })
      .$type<Record<string, number>>()
      .notNull()
      .default(jsonObject),
    byDifficulty: text("by_difficulty", { mode: "json" })
      .$type<Record<string, number>>()
      .notNull()
      .default(jsonObject),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(nowInMilliseconds)
  },
  (table) => [
    check("statistics_singleton_check", sql`${table.id} = 1`),
    check(
      "statistics_nonnegative_totals_check",
      sql`${table.balance} >= 0 and ${table.totalEarned} >= 0 and ${table.totalSpent} >= 0 and ${table.totalPenalties} >= 0 and ${table.currentStreak} >= 0 and ${table.longestStreak} >= 0 and ${table.totalActiveDays} >= 0 and ${table.totalCompletedTasks} >= 0`
    )
  ]
);

export const achievements = sqliteTable(
  "achievements",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull(),
    threshold: integer("threshold").notNull(),
    icon: text("icon").notNull(),
    sortOrder: integer("sort_order").notNull().default(0)
  },
  (table) => [check("achievements_threshold_check", sql`${table.threshold} > 0`)]
);

export const achievementUnlocks = sqliteTable(
  "achievement_unlocks",
  {
    id: text("id").primaryKey(),
    achievementId: text("achievement_id")
      .notNull()
      .references(() => achievements.id),
    unlockedAt: integer("unlocked_at", { mode: "timestamp_ms" })
      .notNull()
      .default(nowInMilliseconds)
  },
  (table) => [uniqueIndex("achievement_unlock_unique_idx").on(table.achievementId)]
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    actor: text("actor", { enum: ACTORS }).notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(jsonObject),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(nowInMilliseconds)
  },
  (table) => [
    index("audit_logs_created_idx").on(table.createdAt),
    index("audit_logs_entity_idx").on(table.entityType, table.entityId),
    check("audit_logs_actor_check", sql`${table.actor} in ('AI', 'user', 'system')`)
  ]
);

export const idempotencyKeys = sqliteTable("idempotency_keys", {
  key: text("key").primaryKey(),
  operation: text("operation").notNull(),
  response: text("response", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(nowInMilliseconds)
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
  submission: one(taskSubmissions, {
    fields: [proofAssets.submissionId],
    references: [taskSubmissions.id]
  })
}));

export const rewardItemRelations = relations(rewardItems, ({ many }) => ({
  redemptions: many(redemptions)
}));

export const redemptionRelations = relations(redemptions, ({ one }) => ({
  rewardItem: one(rewardItems, {
    fields: [redemptions.rewardItemId],
    references: [rewardItems.id]
  })
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
