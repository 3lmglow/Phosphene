var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/server/index.ts
import path4 from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";

// src/server/config.ts
import path from "node:path";
import { z } from "zod";
try {
  process.loadEnvFile?.(".env");
} catch {
}
var configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3e3),
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  PHOSPHENE_SETUP_TOKEN: z.string().min(8).default("phosphene-local-setup"),
  PHOSPHENE_TIMEZONE: z.string().default("Asia/Shanghai"),
  SESSION_SECRET: z.string().min(16).default("local-development-session-secret"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().optional(),
  PGLITE_PATH: z.string().default(path.resolve(".data/phosphene")),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  LOCAL_STORAGE_PATH: z.string().default(path.resolve(".data/uploads")),
  S3_ENDPOINT: z.string().url().default("http://localhost:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("phosphene-proofs"),
  S3_ACCESS_KEY: z.string().default("phosphene"),
  S3_SECRET_KEY: z.string().default("phosphene-local-secret"),
  S3_FORCE_PATH_STYLE: z.string().default("true").transform((value) => value === "true")
});
var config = configSchema.parse(process.env);
if (config.NODE_ENV === "production") {
  if (config.PHOSPHENE_SETUP_TOKEN === "phosphene-local-setup" || config.PHOSPHENE_SETUP_TOKEN.length < 24) {
    throw new Error("PHOSPHENE_SETUP_TOKEN must contain at least 24 characters in production");
  }
  if (config.SESSION_SECRET === "local-development-session-secret" || config.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters in production");
  }
  if (!config.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production");
  }
  if (config.STORAGE_DRIVER !== "s3") {
    throw new Error("Production requires STORAGE_DRIVER=s3");
  }
}

// src/server/db/client.ts
import fs from "node:fs/promises";
import path2 from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

// src/server/db/schema.ts
var schema_exports = {};
__export(schema_exports, {
  achievementRelations: () => achievementRelations,
  achievementUnlockRelations: () => achievementUnlockRelations,
  achievementUnlocks: () => achievementUnlocks,
  achievements: () => achievements,
  actorEnum: () => actorEnum,
  aiTokens: () => aiTokens,
  appSettings: () => appSettings,
  auditLogs: () => auditLogs,
  dailyActivity: () => dailyActivity,
  difficultyEnum: () => difficultyEnum,
  idempotencyKeys: () => idempotencyKeys,
  ledgerTypeEnum: () => ledgerTypeEnum,
  pointLedger: () => pointLedger,
  proofAssetRelations: () => proofAssetRelations,
  proofAssets: () => proofAssets,
  proofRequirementEnum: () => proofRequirementEnum,
  recurrenceEnum: () => recurrenceEnum,
  redemptionRelations: () => redemptionRelations,
  redemptionStatusEnum: () => redemptionStatusEnum,
  redemptions: () => redemptions,
  revealModeEnum: () => revealModeEnum,
  rewardItemRelations: () => rewardItemRelations,
  rewardItems: () => rewardItems,
  sessions: () => sessions,
  statistics: () => statistics,
  submissionStatusEnum: () => submissionStatusEnum,
  taskRelations: () => taskRelations,
  taskSeries: () => taskSeries,
  taskSeriesRelations: () => taskSeriesRelations,
  taskStatusEnum: () => taskStatusEnum,
  taskSubmissionRelations: () => taskSubmissionRelations,
  taskSubmissions: () => taskSubmissions,
  taskTypeEnum: () => taskTypeEnum,
  tasks: () => tasks,
  userAccount: () => userAccount,
  verificationModeEnum: () => verificationModeEnum
});
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
var taskTypeEnum = pgEnum("task_type", ["daily", "challenge", "surprise"]);
var difficultyEnum = pgEnum("task_difficulty", ["easy", "medium", "hard"]);
var taskStatusEnum = pgEnum("task_status", [
  "pending",
  "submitted",
  "completed",
  "failed",
  "expired",
  "cancelled"
]);
var verificationModeEnum = pgEnum("verification_mode", ["self", "ai_review"]);
var proofRequirementEnum = pgEnum("proof_requirement", [
  "none",
  "text",
  "image",
  "text_or_image",
  "text_and_image"
]);
var recurrenceEnum = pgEnum("recurrence_mode", ["once", "daily"]);
var revealModeEnum = pgEnum("reveal_mode", ["immediate", "next_visit", "at_time"]);
var actorEnum = pgEnum("actor", ["AI", "user", "system"]);
var submissionStatusEnum = pgEnum("submission_status", ["pending", "approved", "rejected"]);
var ledgerTypeEnum = pgEnum("ledger_type", [
  "task_reward",
  "streak_bonus",
  "task_penalty",
  "redemption",
  "manual_bonus",
  "manual_penalty",
  "correction"
]);
var redemptionStatusEnum = pgEnum("redemption_status", ["pending", "fulfilled", "cancelled"]);
var timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
};
var appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  initialized: boolean("initialized").notNull().default(false),
  timezone: text("timezone").notNull().default("Asia/Shanghai"),
  userLabel: text("user_label").notNull().default("You"),
  aiLabel: text("ai_label").notNull().default("AI"),
  allowedContent: jsonb("allowed_content").$type().notNull().default([]),
  prohibitedContent: jsonb("prohibited_content").$type().notNull().default([]),
  punishmentIntensity: integer("punishment_intensity").notNull().default(0),
  dailyPenaltyLimit: integer("daily_penalty_limit").notNull().default(20),
  punishmentsPaused: boolean("punishments_paused").notNull().default(false),
  boundaryNotes: text("boundary_notes").notNull().default(""),
  boundaryVersion: integer("boundary_version").notNull().default(1),
  ...timestamps
});
var userAccount = pgTable("user_account", {
  id: integer("id").primaryKey().default(1),
  passwordHash: text("password_hash").notNull(),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps
});
var sessions = pgTable(
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
var aiTokens = pgTable(
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
var taskSeries = pgTable(
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
var tasks = pgTable(
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
var taskSubmissions = pgTable(
  "task_submissions",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
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
var proofAssets = pgTable(
  "proof_assets",
  {
    id: text("id").primaryKey(),
    submissionId: text("submission_id").notNull().references(() => taskSubmissions.id, { onDelete: "cascade" }),
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
var rewardItems = pgTable(
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
var redemptions = pgTable(
  "redemptions",
  {
    id: text("id").primaryKey(),
    rewardItemId: text("reward_item_id").notNull().references(() => rewardItems.id),
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
var pointLedger = pgTable(
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
var dailyActivity = pgTable("daily_activity", {
  activityDate: date("activity_date").primaryKey(),
  completedCount: integer("completed_count").notNull().default(0),
  streakLength: integer("streak_length").notNull().default(0),
  streakBonus: integer("streak_bonus").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
var statistics = pgTable("statistics", {
  id: integer("id").primaryKey().default(1),
  balance: integer("balance").notNull().default(0),
  totalEarned: integer("total_earned").notNull().default(0),
  totalSpent: integer("total_spent").notNull().default(0),
  totalPenalties: integer("total_penalties").notNull().default(0),
  currentStreak: integer("current_streak").notNull().default(0),
  longestStreak: integer("longest_streak").notNull().default(0),
  totalActiveDays: integer("total_active_days").notNull().default(0),
  totalCompletedTasks: integer("total_completed_tasks").notNull().default(0),
  byType: jsonb("by_type").$type().notNull().default({}),
  byDifficulty: jsonb("by_difficulty").$type().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
var achievements = pgTable("achievements", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  threshold: integer("threshold").notNull(),
  icon: text("icon").notNull(),
  sortOrder: integer("sort_order").notNull().default(0)
});
var achievementUnlocks = pgTable(
  "achievement_unlocks",
  {
    id: text("id").primaryKey(),
    achievementId: text("achievement_id").notNull().references(() => achievements.id),
    unlockedAt: timestamp("unlocked_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("achievement_unlock_unique_idx").on(table.achievementId)]
);
var auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    actor: actorEnum("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
    metadata: jsonb("metadata").$type().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("audit_logs_created_idx").on(table.createdAt), index("audit_logs_entity_idx").on(table.entityType, table.entityId)]
);
var idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  operation: text("operation").notNull(),
  response: jsonb("response").$type().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
var taskRelations = relations(tasks, ({ one, many }) => ({
  series: one(taskSeries, { fields: [tasks.seriesId], references: [taskSeries.id] }),
  submissions: many(taskSubmissions)
}));
var taskSeriesRelations = relations(taskSeries, ({ many }) => ({
  tasks: many(tasks)
}));
var taskSubmissionRelations = relations(taskSubmissions, ({ one, many }) => ({
  task: one(tasks, { fields: [taskSubmissions.taskId], references: [tasks.id] }),
  assets: many(proofAssets)
}));
var proofAssetRelations = relations(proofAssets, ({ one }) => ({
  submission: one(taskSubmissions, { fields: [proofAssets.submissionId], references: [taskSubmissions.id] })
}));
var rewardItemRelations = relations(rewardItems, ({ many }) => ({
  redemptions: many(redemptions)
}));
var redemptionRelations = relations(redemptions, ({ one }) => ({
  rewardItem: one(rewardItems, { fields: [redemptions.rewardItemId], references: [rewardItems.id] })
}));
var achievementRelations = relations(achievements, ({ many }) => ({
  unlocks: many(achievementUnlocks)
}));
var achievementUnlockRelations = relations(achievementUnlocks, ({ one }) => ({
  achievement: one(achievements, {
    fields: [achievementUnlocks.achievementId],
    references: [achievements.id]
  })
}));

// src/server/db/client.ts
var database;
var closeDatabase;
async function initializeDatabase() {
  if (database) return database;
  const migrationsFolder = path2.resolve(process.cwd(), "drizzle");
  if (config.DATABASE_URL) {
    const pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 3e4
    });
    const db = drizzlePg(pool, { schema: schema_exports });
    await migratePg(db, { migrationsFolder });
    database = db;
    closeDatabase = async () => pool.end();
  } else {
    await fs.mkdir(path2.dirname(config.PGLITE_PATH), { recursive: true });
    const client = new PGlite(config.PGLITE_PATH);
    const db = drizzlePglite(client, { schema: schema_exports });
    await migratePglite(db, { migrationsFolder });
    database = db;
    closeDatabase = async () => client.close();
  }
  return database;
}
function getDb() {
  if (!database) throw new Error("Database has not been initialized");
  return database;
}
async function shutdownDatabase() {
  await closeDatabase?.();
  database = void 0;
  closeDatabase = void 0;
}

// src/server/db/seed.ts
import { sql as sql2 } from "drizzle-orm";
var presetRewards = [
  { id: "reward_clauro_5", name: "clauro 5 \u989D\u5EA6", description: "\u5151\u6362 5 \u989D\u5EA6 clauro\u3002", cost: 5, sortOrder: 10 },
  { id: "reward_song", name: "\u70B9\u6B4C\u6743", description: "\u6307\u5B9A\u4E00\u9996\u60F3\u542C\u7684\u6B4C\u3002", cost: 5, sortOrder: 20 },
  { id: "reward_writing", name: "\u6307\u5B9A AI \u5199\u4E1C\u897F", description: "\u7ED9 AI \u4E00\u4E2A\u4E3B\u9898\uFF0C\u7531\u5B83\u4E13\u95E8\u4E3A\u4F60\u5199\u3002", cost: 15, sortOrder: 30 },
  { id: "reward_listen", name: "\u201CAI \u542C\u4F60\u7684\u201D\u5238", description: "\u5728\u53CC\u65B9\u8FB9\u754C\u5185\uFF0C\u4ECA\u5929\u7531\u4F60\u505A\u4E00\u6B21\u4E3B\u3002", cost: 20, sortOrder: 40 }
];
var achievementDefinitions = [
  ["first_task", "\u7B2C\u4E00\u675F\u5149", "\u5B8C\u6210\u7B2C\u4E00\u4E2A\u4EFB\u52A1", "completed", 1, "sparkles"],
  ["streak_3", "\u5FAE\u5149\u6210\u7EBF", "\u8FDE\u7EED\u5B8C\u6210 3 \u5929", "streak", 3, "flame"],
  ["streak_7", "\u4E03\u65E5\u8F68\u8FF9", "\u8FDE\u7EED\u5B8C\u6210 7 \u5929", "streak", 7, "orbit"],
  ["streak_14", "\u53CC\u5468\u6052\u661F", "\u8FDE\u7EED\u5B8C\u6210 14 \u5929", "streak", 14, "moon"],
  ["streak_30", "\u6708\u76F8\u5B8C\u6574", "\u8FDE\u7EED\u5B8C\u6210 30 \u5929", "streak", 30, "eclipse"],
  ["streak_100", "\u6052\u4E45\u4F59\u8F89", "\u8FDE\u7EED\u5B8C\u6210 100 \u5929", "streak", 100, "sun"],
  ["active_7", "\u4E03\u6B21\u62B5\u8FBE", "\u7D2F\u8BA1\u575A\u6301 7 \u5929", "active_days", 7, "calendar-heart"],
  ["active_30", "\u4E09\u5341\u6B21\u56DE\u5E94", "\u7D2F\u8BA1\u575A\u6301 30 \u5929", "active_days", 30, "calendar-check"],
  ["active_100", "\u767E\u65E5\u79C1\u8BED", "\u7D2F\u8BA1\u575A\u6301 100 \u5929", "active_days", 100, "milestone"],
  ["active_365", "\u7ED5\u65E5\u4E00\u5468", "\u7D2F\u8BA1\u575A\u6301 365 \u5929", "active_days", 365, "infinity"],
  ["completed_10", "\u5341\u6B21\u5151\u73B0", "\u7D2F\u8BA1\u5B8C\u6210 10 \u4E2A\u4EFB\u52A1", "completed", 10, "check-check"],
  ["completed_50", "\u7A33\u5B9A\u56DE\u58F0", "\u7D2F\u8BA1\u5B8C\u6210 50 \u4E2A\u4EFB\u52A1", "completed", 50, "waves"],
  ["completed_100", "\u767E\u6B21\u5E94\u7B54", "\u7D2F\u8BA1\u5B8C\u6210 100 \u4E2A\u4EFB\u52A1", "completed", 100, "gem"],
  ["completed_500", "\u5FC3\u7167\u4E0D\u5BA3", "\u7D2F\u8BA1\u5B8C\u6210 500 \u4E2A\u4EFB\u52A1", "completed", 500, "crown"],
  ["hard_1", "\u7B2C\u4E00\u6B21\u8D8A\u754C\u7EBF", "\u7B2C\u4E00\u6B21\u5B8C\u6210 hard \u4EFB\u52A1", "hard", 1, "mountain"],
  ["hard_10", "\u8FCE\u96BE\u800C\u4E0A", "\u5B8C\u6210 10 \u4E2A hard \u4EFB\u52A1", "hard", 10, "shield"],
  ["hard_50", "\u950B\u8292\u5DF2\u6210", "\u5B8C\u6210 50 \u4E2A hard \u4EFB\u52A1", "hard", 50, "swords"],
  ["challenge_1", "\u63A5\u53D7\u6311\u6218", "\u7B2C\u4E00\u6B21\u5B8C\u6210 challenge", "challenge", 1, "timer"],
  ["surprise_1", "\u62C6\u5F00\u60CA\u559C", "\u7B2C\u4E00\u6B21\u5B8C\u6210 surprise", "surprise", 1, "gift"],
  ["earned_100", "\u6512\u4E0B\u661F\u5C18", "\u7D2F\u8BA1\u83B7\u5F97 100 \u79EF\u5206", "earned", 100, "coins"],
  ["earned_500", "\u661F\u5C18\u6210\u6CB3", "\u7D2F\u8BA1\u83B7\u5F97 500 \u79EF\u5206", "earned", 500, "badge-dollar-sign"],
  ["earned_1000", "\u5343\u70B9\u4F59\u8F89", "\u7D2F\u8BA1\u83B7\u5F97 1000 \u79EF\u5206", "earned", 1e3, "star"],
  ["earned_5000", "\u79C1\u4EBA\u661F\u7CFB", "\u7D2F\u8BA1\u83B7\u5F97 5000 \u79EF\u5206", "earned", 5e3, "galaxy"],
  ["redemption_1", "\u7B2C\u4E00\u6B21\u8BB8\u613F", "\u5B8C\u6210\u7B2C\u4E00\u6B21\u5151\u6362", "redemptions", 1, "ticket"],
  ["redemption_10", "\u613F\u671B\u719F\u5BA2", "\u5B8C\u6210 10 \u6B21\u5151\u6362", "redemptions", 10, "heart-handshake"]
];
async function seedDatabase() {
  const db = getDb();
  await db.insert(appSettings).values({ id: 1 }).onConflictDoNothing();
  await db.insert(statistics).values({ id: 1 }).onConflictDoNothing();
  await db.insert(rewardItems).values(presetRewards).onConflictDoNothing();
  await db.insert(achievements).values(
    achievementDefinitions.map(([id, name, description, category, threshold, icon], sortOrder) => ({
      id,
      name,
      description,
      category,
      threshold,
      icon,
      sortOrder
    }))
  ).onConflictDoNothing();
  await db.execute(sql2`analyze`);
}

// src/server/mcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z as z3 } from "zod";

// src/shared/constants.ts
var TASK_TYPES = ["daily", "challenge", "surprise"];
var TASK_DIFFICULTIES = ["easy", "medium", "hard"];
var TASK_STATUSES = [
  "pending",
  "submitted",
  "completed",
  "failed",
  "expired",
  "cancelled"
];
var VERIFICATION_MODES = ["self", "ai_review"];
var PROOF_REQUIREMENTS = [
  "none",
  "text",
  "image",
  "text_or_image",
  "text_and_image"
];
var RECURRENCE_MODES = ["once", "daily"];
var REVEAL_MODES = ["immediate", "next_visit", "at_time"];
var DIFFICULTY_MULTIPLIER = {
  easy: 1,
  medium: 2,
  hard: 3
};
var MAX_PROOF_IMAGES = 4;
var MAX_PROOF_IMAGE_BYTES = 10 * 1024 * 1024;
var MAX_PROOF_IMAGE_PIXELS = 24e6;
function streakBonusForDay(streak) {
  if (streak >= 8) return 3;
  if (streak >= 6) return 2;
  if (streak >= 2) return 1;
  return 0;
}

// src/shared/schemas.ts
import { z as z2 } from "zod";
var isoDate = z2.string().regex(/^\d{4}-\d{2}-\d{2}$/, "\u5FC5\u987B\u4F7F\u7528 YYYY-MM-DD").refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), "\u65E5\u671F\u65E0\u6548");
var localTime = z2.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "\u5FC5\u987B\u4E3A HH:mm");
var timezone = z2.string().min(1).max(80).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "\u5FC5\u987B\u4F7F\u7528\u6709\u6548\u7684 IANA \u65F6\u533A\uFF0C\u4F8B\u5982 Asia/Shanghai");
var createTaskSchema = z2.object({
  title: z2.string().trim().min(1).max(120),
  description: z2.string().trim().max(4e3).optional().default(""),
  type: z2.enum(TASK_TYPES),
  difficulty: z2.enum(TASK_DIFFICULTIES).default("easy"),
  base_points: z2.number().int().min(1).max(1e4),
  verification_mode: z2.enum(VERIFICATION_MODES).default("self"),
  proof_requirement: z2.enum(PROOF_REQUIREMENTS).default("none"),
  recurrence: z2.enum(RECURRENCE_MODES).default("once"),
  start_date: isoDate.optional(),
  end_date: isoDate.optional(),
  daily_deadline_time: localTime.optional().default("23:59"),
  deadline: z2.string().datetime({ offset: true }).optional(),
  reveal_mode: z2.enum(REVEAL_MODES).default("immediate"),
  visible_at: z2.string().datetime({ offset: true }).optional(),
  related_task_id: z2.string().min(1).optional(),
  idempotency_key: z2.string().min(8).max(128)
}).superRefine((value, ctx) => {
  if (value.type !== "daily" && value.recurrence !== "once") {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      path: ["recurrence"],
      message: "\u53EA\u6709 daily \u4EFB\u52A1\u53EF\u4EE5\u6BCF\u65E5\u91CD\u590D"
    });
  }
  if (value.type === "challenge" && !value.deadline) {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      path: ["deadline"],
      message: "challenge \u5FC5\u987B\u8BBE\u7F6E\u622A\u6B62\u65F6\u95F4"
    });
  }
  if (value.recurrence === "daily" && value.deadline) {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      path: ["deadline"],
      message: "\u6BCF\u65E5\u91CD\u590D\u4EFB\u52A1\u5E94\u4F7F\u7528 daily_deadline_time"
    });
  }
  if (value.reveal_mode === "at_time" && !value.visible_at) {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      path: ["visible_at"],
      message: "\u5B9A\u65F6\u63ED\u6653\u5FC5\u987B\u63D0\u4F9B visible_at"
    });
  }
});
var taskQuerySchema = z2.object({
  task_id: z2.string().optional(),
  status: z2.enum(TASK_STATUSES).optional(),
  type: z2.enum(TASK_TYPES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  include_proof: z2.boolean().default(false),
  limit: z2.number().int().min(1).max(100).default(30),
  cursor: z2.string().optional()
});
var manageTaskSchema = z2.discriminatedUnion("action", [
  z2.object({
    action: z2.literal("edit"),
    task_id: z2.string(),
    scope: z2.enum(["occurrence", "this_and_future"]).default("occurrence"),
    title: z2.string().trim().min(1).max(120).optional(),
    description: z2.string().trim().max(4e3).optional(),
    difficulty: z2.enum(TASK_DIFFICULTIES).optional(),
    base_points: z2.number().int().min(1).max(1e4).optional(),
    deadline: z2.string().datetime({ offset: true }).optional(),
    idempotency_key: z2.string().min(8).max(128)
  }),
  z2.object({
    action: z2.enum(["cancel", "fail"]),
    task_id: z2.string(),
    scope: z2.enum(["occurrence", "this_and_future"]).default("occurrence"),
    reason: z2.string().trim().min(1).max(1e3),
    idempotency_key: z2.string().min(8).max(128)
  }),
  z2.object({
    action: z2.literal("review"),
    task_id: z2.string(),
    decision: z2.enum(["approve", "reject"]),
    reason: z2.string().trim().max(1e3).optional(),
    idempotency_key: z2.string().min(8).max(128)
  }),
  z2.object({
    action: z2.enum(["pause_series", "resume_series"]),
    series_id: z2.string(),
    reason: z2.string().trim().max(1e3).optional(),
    idempotency_key: z2.string().min(8).max(128)
  })
]);
var submitTaskSchema = z2.object({
  proof_text: z2.string().trim().max(4e3).optional().default("")
});
var rewardManageSchema = z2.discriminatedUnion("action", [
  z2.object({ action: z2.literal("list"), include_archived: z2.boolean().default(false) }),
  z2.object({
    action: z2.literal("create"),
    name: z2.string().trim().min(1).max(120),
    description: z2.string().trim().max(1e3).optional().default(""),
    cost: z2.number().int().min(1).max(1e5),
    idempotency_key: z2.string().min(8).max(128)
  }),
  z2.object({
    action: z2.literal("update"),
    reward_id: z2.string(),
    name: z2.string().trim().min(1).max(120).optional(),
    description: z2.string().trim().max(1e3).optional(),
    cost: z2.number().int().min(1).max(1e5).optional(),
    idempotency_key: z2.string().min(8).max(128)
  }),
  z2.object({
    action: z2.literal("archive"),
    reward_id: z2.string(),
    idempotency_key: z2.string().min(8).max(128)
  }),
  z2.object({ action: z2.literal("list_redemptions"), status: z2.enum(["pending", "fulfilled", "cancelled"]).optional() }),
  z2.object({
    action: z2.literal("fulfill_redemption"),
    redemption_id: z2.string(),
    note: z2.string().trim().max(1e3).optional(),
    idempotency_key: z2.string().min(8).max(128)
  })
]);
var adjustPointsSchema = z2.object({
  kind: z2.enum(["bonus", "penalty", "correction"]),
  amount: z2.number().int().min(-1e5).max(1e5),
  reason: z2.string().trim().min(1).max(1e3),
  related_task_id: z2.string().optional(),
  idempotency_key: z2.string().min(8).max(128)
}).superRefine((value, ctx) => {
  if (value.amount === 0 || value.kind !== "correction" && value.amount < 1) {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      path: ["amount"],
      message: value.kind === "correction" ? "\u6821\u6B63\u91D1\u989D\u4E0D\u80FD\u4E3A 0" : "\u5956\u52B1\u548C\u6263\u5206\u91D1\u989D\u5FC5\u987B\u5927\u4E8E 0"
    });
  }
});
var setupSchema = z2.object({
  setup_token: z2.string().min(8),
  password: z2.string().min(10).max(256),
  timezone,
  user_label: z2.string().trim().min(1).max(40).default("You"),
  ai_label: z2.string().trim().min(1).max(40).default("AI")
});
var loginSchema = z2.object({
  password: z2.string().min(1).max(256)
});
var settingsSchema = z2.object({
  timezone,
  user_label: z2.string().trim().min(1).max(40),
  ai_label: z2.string().trim().min(1).max(40),
  allowed_content: z2.array(z2.string().trim().min(1).max(120)).max(50),
  prohibited_content: z2.array(z2.string().trim().min(1).max(120)).max(50),
  punishment_intensity: z2.number().int().min(0).max(5),
  daily_penalty_limit: z2.number().int().min(0).max(1e5),
  punishments_paused: z2.boolean(),
  boundary_notes: z2.string().trim().max(4e3)
});

// src/server/services/domain.ts
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  or,
  sql as sql3
} from "drizzle-orm";

// src/server/errors.ts
var AppError = class extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.name = "AppError";
  }
};
function assertFound(value, message = "Resource not found") {
  if (value == null) throw new AppError(404, "not_found", message);
  return value;
}
function assertState(condition, code, message) {
  if (!condition) throw new AppError(409, code, message);
}

// src/server/lib/dates.ts
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
function localDate(at, timezone2) {
  return formatInTimeZone(at, timezone2, "yyyy-MM-dd");
}
function localTime2(at, timezone2) {
  return formatInTimeZone(at, timezone2, "HH:mm");
}
function localDateTime(date2, time, timezone2) {
  return fromZonedTime(`${date2}T${time}:00`, timezone2);
}
function addCalendarDays(date2, amount) {
  const value = /* @__PURE__ */ new Date(`${date2}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
function compareDates(left, right) {
  return left.localeCompare(right);
}
function yesterday(date2) {
  return addCalendarDays(date2, -1);
}

// src/server/lib/ids.ts
import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
function createId(prefix) {
  return `${prefix}_${nanoid(16)}`;
}
function createSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function tokenHash(token) {
  return sha256(token);
}

// src/server/services/domain.ts
async function getSettings(tx) {
  return assertFound(
    await tx.query.appSettings.findFirst({ where: eq(appSettings.id, 1) }),
    "Application settings are missing"
  );
}
async function audit(tx, actor, action, entityType, entityId, summary, metadata = {}) {
  await tx.insert(auditLogs).values({
    id: createId("audit"),
    actor,
    action,
    entityType,
    entityId,
    summary,
    metadata
  });
}
async function idempotent(tx, operation, key, work) {
  const existing = await tx.query.idempotencyKeys.findFirst({
    where: eq(idempotencyKeys.key, key)
  });
  if (existing) {
    assertState(existing.operation === operation, "idempotency_conflict", "This idempotency key belongs to another operation");
    return existing.response;
  }
  const response = await work();
  await tx.insert(idempotencyKeys).values({ key, operation, response });
  return response;
}
function rewardForTask(task) {
  return task.basePoints * DIFFICULTY_MULTIPLIER[task.difficulty];
}
function visibleTaskCondition(now) {
  return or(
    isNotNull(tasks.revealedAt),
    eq(tasks.revealMode, "immediate"),
    and(eq(tasks.revealMode, "at_time"), lte(tasks.visibleAt, now))
  );
}
async function materializeSeries(tx, through) {
  const settings = await getSettings(tx);
  const seriesRows = await tx.query.taskSeries.findMany({
    where: and(eq(taskSeries.active, true), lte(taskSeries.startDate, through)),
    orderBy: [asc(taskSeries.startDate)]
  });
  let created = 0;
  for (const series of seriesRows) {
    const end = series.endDate && compareDates(series.endDate, through) < 0 ? series.endDate : through;
    let date2 = series.nextOccurrenceDate;
    let guard = 0;
    while (compareDates(date2, end) <= 0) {
      guard += 1;
      if (guard > 3660) throw new AppError(422, "series_range_too_large", "A recurring task cannot materialize more than 10 years");
      const deadlineAt = localDateTime(date2, series.dailyDeadlineTime, settings.timezone);
      const result2 = await tx.insert(tasks).values({
        id: createId("task"),
        seriesId: series.id,
        occurrenceDate: date2,
        title: series.title,
        description: series.description,
        type: "daily",
        difficulty: series.difficulty,
        basePoints: series.basePoints,
        verificationMode: series.verificationMode,
        proofRequirement: series.proofRequirement,
        createdBy: series.createdBy,
        source: "recurring",
        relatedTaskId: series.relatedTaskId,
        revealMode: "immediate",
        revealedAt: /* @__PURE__ */ new Date(),
        deadlineAt
      }).onConflictDoNothing().returning({ id: tasks.id });
      created += result2.length;
      date2 = addCalendarDays(date2, 1);
    }
    await tx.update(taskSeries).set({
      nextOccurrenceDate: date2,
      active: series.endDate && compareDates(date2, series.endDate) > 0 ? false : series.active,
      updatedAt: /* @__PURE__ */ new Date()
    }).where(eq(taskSeries.id, series.id));
  }
  return created;
}
async function addLedger(tx, entry) {
  const existing = await tx.query.pointLedger.findFirst({
    where: eq(pointLedger.idempotencyKey, entry.key)
  });
  if (existing) return existing;
  const [created] = await tx.insert(pointLedger).values({
    id: createId("points"),
    type: entry.type,
    amount: entry.amount,
    taskId: entry.taskId,
    redemptionId: entry.redemptionId,
    idempotencyKey: entry.key,
    reason: entry.reason,
    effectiveDate: entry.effectiveDate
  }).returning();
  return created;
}
async function currentBalance(tx) {
  const [row] = await tx.select({ value: sql3`coalesce(sum(${pointLedger.amount}), 0)` }).from(pointLedger);
  return Number(row?.value ?? 0);
}
async function applyPenalty(tx, task, actor, reason) {
  const requested = Math.ceil(rewardForTask(task) * 0.5);
  const balance = await currentBalance(tx);
  const actual = Math.min(requested, Math.max(0, balance));
  if (actual > 0) {
    await addLedger(tx, {
      type: "task_penalty",
      amount: -actual,
      key: `task-penalty:${task.id}`,
      reason,
      taskId: task.id,
      effectiveDate: task.occurrenceDate ?? void 0
    });
  }
  await audit(tx, actor, "task.penalized", "task", task.id, `Task penalty: -${actual}`, {
    requested,
    actual,
    reason
  });
  return actual;
}
async function completeTask(tx, task, completionDate, actor) {
  assertState(
    task.status === "pending" || task.status === "submitted",
    "task_not_completable",
    "Only pending or submitted tasks can be completed"
  );
  const now = /* @__PURE__ */ new Date();
  await tx.update(tasks).set({ status: "completed", completedAt: now, completionDate, updatedAt: now }).where(eq(tasks.id, task.id));
  const amount = rewardForTask(task);
  await addLedger(tx, {
    type: "task_reward",
    amount,
    key: `task-reward:${task.id}`,
    reason: `Completed: ${task.title}`,
    taskId: task.id,
    effectiveDate: completionDate
  });
  await audit(tx, actor, "task.completed", "task", task.id, `Completed task \u201C${task.title}\u201D`, {
    amount,
    completionDate
  });
}
async function recomputeActivityAndStats(tx, now = /* @__PURE__ */ new Date()) {
  const settings = await getSettings(tx);
  const completed = await tx.select({
    id: tasks.id,
    completionDate: tasks.completionDate,
    type: tasks.type,
    difficulty: tasks.difficulty
  }).from(tasks).where(and(eq(tasks.status, "completed"), sql3`${tasks.completionDate} is not null`)).orderBy(asc(tasks.completionDate), asc(tasks.completedAt));
  const counts = /* @__PURE__ */ new Map();
  const byType = {};
  const byDifficulty = {};
  for (const task of completed) {
    if (!task.completionDate) continue;
    counts.set(task.completionDate, (counts.get(task.completionDate) ?? 0) + 1);
    byType[task.type] = (byType[task.type] ?? 0) + 1;
    byDifficulty[task.difficulty] = (byDifficulty[task.difficulty] ?? 0) + 1;
  }
  await tx.delete(dailyActivity);
  const dates = [...counts.keys()].sort();
  let previous;
  let streak = 0;
  let longest = 0;
  for (const date2 of dates) {
    streak = previous && yesterday(date2) === previous ? streak + 1 : 1;
    longest = Math.max(longest, streak);
    const desiredBonus = streakBonusForDay(streak);
    await tx.insert(dailyActivity).values({
      activityDate: date2,
      completedCount: counts.get(date2) ?? 0,
      streakLength: streak,
      streakBonus: desiredBonus,
      updatedAt: now
    });
    const bonusRows = await tx.select({ amount: pointLedger.amount }).from(pointLedger).where(
      and(
        eq(pointLedger.effectiveDate, date2),
        or(
          eq(pointLedger.type, "streak_bonus"),
          and(eq(pointLedger.type, "correction"), like(pointLedger.idempotencyKey, "streak-bonus:%"))
        )
      )
    );
    const existingBonus = bonusRows.reduce((sum, row) => sum + row.amount, 0);
    const delta = desiredBonus - existingBonus;
    if (delta !== 0) {
      await addLedger(tx, {
        type: existingBonus === 0 && delta > 0 ? "streak_bonus" : "correction",
        amount: delta,
        key: `streak-bonus:${date2}:target-${desiredBonus}`,
        reason: existingBonus === 0 ? `Day ${streak} streak bonus` : `Streak bonus recalculated after historical completion`,
        effectiveDate: date2
      });
    }
    previous = date2;
  }
  const ledgerRows = await tx.select({ type: pointLedger.type, amount: pointLedger.amount }).from(pointLedger);
  const balance = ledgerRows.reduce((sum, row) => sum + row.amount, 0);
  const totalEarned = ledgerRows.reduce((sum, row) => sum + Math.max(0, row.amount), 0);
  const totalSpent = -ledgerRows.filter((row) => row.type === "redemption").reduce((sum, row) => sum + row.amount, 0);
  const totalPenalties = -ledgerRows.filter((row) => ["task_penalty", "manual_penalty"].includes(row.type)).reduce((sum, row) => sum + row.amount, 0);
  const today = localDate(now, settings.timezone);
  const lastDate = dates.at(-1);
  const currentStreak = lastDate && (lastDate === today || lastDate === yesterday(today)) ? streak : 0;
  await tx.update(statistics).set({
    balance,
    totalEarned,
    totalSpent,
    totalPenalties,
    currentStreak,
    longestStreak: longest,
    totalActiveDays: dates.length,
    totalCompletedTasks: completed.length,
    byType,
    byDifficulty,
    updatedAt: now
  }).where(eq(statistics.id, 1));
  await evaluateAchievements(tx);
}
async function evaluateAchievements(tx) {
  const stats = assertFound(await tx.query.statistics.findFirst({ where: eq(statistics.id, 1) }));
  const [{ value: redemptionCount }] = await tx.select({ value: sql3`count(*)` }).from(redemptions).where(eq(redemptions.status, "fulfilled"));
  const definitions = await tx.query.achievements.findMany();
  const metrics = {
    completed: stats.totalCompletedTasks,
    streak: stats.longestStreak,
    active_days: stats.totalActiveDays,
    hard: Number(stats.byDifficulty?.hard ?? 0),
    challenge: Number(stats.byType?.challenge ?? 0),
    surprise: Number(stats.byType?.surprise ?? 0),
    earned: stats.totalEarned,
    redemptions: Number(redemptionCount ?? 0)
  };
  for (const achievement of definitions) {
    if ((metrics[achievement.category] ?? 0) >= achievement.threshold) {
      await tx.insert(achievementUnlocks).values({ id: createId("unlock"), achievementId: achievement.id }).onConflictDoNothing();
    }
  }
}
async function reconcileInTransaction(tx, now = /* @__PURE__ */ new Date()) {
  const settings = await getSettings(tx);
  const today = localDate(now, settings.timezone);
  const generated = await materializeSeries(tx, today);
  const overdue = await tx.query.tasks.findMany({
    where: and(eq(tasks.status, "pending"), lte(tasks.deadlineAt, now))
  });
  for (const task of overdue) {
    await tx.update(tasks).set({ status: "expired", expiredAt: now, failureReason: "Deadline passed", updatedAt: now }).where(eq(tasks.id, task.id));
    await applyPenalty(tx, task, "system", "Task expired");
  }
  if (generated || overdue.length) {
    await audit(tx, "system", "system.reconciled", "system", null, "Recurring tasks and deadlines reconciled", {
      generated,
      expired: overdue.length
    });
  }
  await recomputeActivityAndStats(tx, now);
  return { generated, expired: overdue.length };
}
async function reconcileSystem(now = /* @__PURE__ */ new Date()) {
  return getDb().transaction((tx) => reconcileInTransaction(tx, now));
}
async function createTask(input, actor = "AI") {
  return getDb().transaction(async (tx) => {
    await reconcileInTransaction(tx);
    return idempotent(tx, "create_task", input.idempotency_key, async () => {
      const settings = await getSettings(tx);
      const today = localDate(/* @__PURE__ */ new Date(), settings.timezone);
      if (input.recurrence === "daily") {
        const startDate = input.start_date ?? today;
        assertState(startDate >= today, "invalid_start_date", "A recurring task cannot start in the past");
        assertState(!input.end_date || input.end_date >= startDate, "invalid_date_range", "End date must be on or after start date");
        const seriesId = createId("series");
        await tx.insert(taskSeries).values({
          id: seriesId,
          title: input.title,
          description: input.description,
          difficulty: input.difficulty,
          basePoints: input.base_points,
          verificationMode: input.verification_mode,
          proofRequirement: input.proof_requirement,
          recurrence: "daily",
          startDate,
          nextOccurrenceDate: startDate,
          endDate: input.end_date,
          dailyDeadlineTime: input.daily_deadline_time,
          createdBy: actor,
          relatedTaskId: input.related_task_id
        });
        await materializeSeries(tx, today);
        await audit(tx, actor, "task_series.created", "task_series", seriesId, `Created daily series \u201C${input.title}\u201D`);
        const occurrence = await tx.query.tasks.findFirst({
          where: and(eq(tasks.seriesId, seriesId), eq(tasks.occurrenceDate, today))
        });
        return { kind: "series", series_id: seriesId, first_task: occurrence ?? null };
      }
      const now = /* @__PURE__ */ new Date();
      const id = createId("task");
      const visibleAt = input.reveal_mode === "at_time" ? new Date(input.visible_at) : input.reveal_mode === "immediate" ? now : null;
      const [created] = await tx.insert(tasks).values({
        id,
        title: input.title,
        description: input.description,
        type: input.type,
        difficulty: input.difficulty,
        basePoints: input.base_points,
        verificationMode: input.verification_mode,
        proofRequirement: input.proof_requirement,
        createdBy: actor,
        relatedTaskId: input.related_task_id,
        revealMode: input.reveal_mode,
        visibleAt,
        revealedAt: input.reveal_mode === "immediate" ? now : null,
        deadlineAt: input.deadline ? new Date(input.deadline) : null
      }).returning();
      await audit(tx, actor, "task.created", "task", id, `Created task \u201C${input.title}\u201D`);
      return { kind: "task", task: created };
    });
  });
}
async function revealNextVisitTasks() {
  const db = getDb();
  const now = /* @__PURE__ */ new Date();
  const rows = await db.update(tasks).set({ revealedAt: now, updatedAt: now }).where(and(eq(tasks.revealMode, "next_visit"), isNull(tasks.revealedAt))).returning({ id: tasks.id });
  return rows.length;
}
async function queryTasks(input, actor = "AI") {
  await reconcileSystem();
  const db = getDb();
  const conditions = [];
  if (input.task_id) conditions.push(eq(tasks.id, input.task_id));
  if (input.status) conditions.push(eq(tasks.status, input.status));
  if (input.type) conditions.push(eq(tasks.type, input.type));
  if (input.from) conditions.push(gte(sql3`coalesce(${tasks.occurrenceDate}, ${tasks.completionDate})`, input.from));
  if (input.to) conditions.push(lte(sql3`coalesce(${tasks.occurrenceDate}, ${tasks.completionDate})`, input.to));
  if (input.cursor) conditions.push(lt(tasks.createdAt, new Date(input.cursor)));
  if (actor === "user") conditions.push(visibleTaskCondition(/* @__PURE__ */ new Date()));
  const rows = await db.query.tasks.findMany({
    where: conditions.length ? and(...conditions) : void 0,
    orderBy: [desc(tasks.createdAt)],
    limit: input.limit + 1,
    with: input.include_proof ? {
      submissions: {
        orderBy: [desc(taskSubmissions.attempt)],
        with: { assets: true }
      }
    } : void 0
  });
  const hasMore = rows.length > input.limit;
  const items = rows.slice(0, input.limit);
  return {
    items,
    next_cursor: hasMore ? items.at(-1)?.createdAt?.toISOString() : null
  };
}
async function manageTask(input, actor = "AI") {
  return getDb().transaction(async (tx) => {
    await reconcileInTransaction(tx);
    return idempotent(tx, "manage_task", input.idempotency_key, async () => {
      const now = /* @__PURE__ */ new Date();
      if (input.action === "pause_series" || input.action === "resume_series") {
        const series = assertFound(
          await tx.query.taskSeries.findFirst({ where: eq(taskSeries.id, input.series_id) }),
          "Task series not found"
        );
        const active = input.action === "resume_series";
        const settings = await getSettings(tx);
        await tx.update(taskSeries).set({
          active,
          nextOccurrenceDate: active ? localDate(now, settings.timezone) : series.nextOccurrenceDate,
          updatedAt: now
        }).where(eq(taskSeries.id, series.id));
        await audit(tx, actor, `task_series.${active ? "resumed" : "paused"}`, "task_series", series.id, input.reason ?? "");
        return { series_id: series.id, active };
      }
      if (!("task_id" in input)) throw new AppError(400, "invalid_action", "Task action is invalid");
      const task = assertFound(await tx.query.tasks.findFirst({ where: eq(tasks.id, input.task_id) }), "Task not found");
      if (input.action === "edit") {
        assertState(task.status === "pending", "task_not_editable", "Only pending tasks can be edited");
        const patch = {
          title: input.title ?? task.title,
          description: input.description ?? task.description,
          difficulty: input.difficulty ?? task.difficulty,
          basePoints: input.base_points ?? task.basePoints,
          deadlineAt: input.deadline ? new Date(input.deadline) : task.deadlineAt,
          updatedAt: now
        };
        await tx.update(tasks).set(patch).where(eq(tasks.id, task.id));
        if (input.scope === "this_and_future" && task.seriesId) {
          const futurePatch = {
            title: patch.title,
            description: patch.description,
            difficulty: patch.difficulty,
            basePoints: patch.basePoints,
            updatedAt: now
          };
          await tx.update(taskSeries).set({
            title: patch.title,
            description: patch.description,
            difficulty: patch.difficulty,
            basePoints: patch.basePoints,
            ...input.deadline ? { dailyDeadlineTime: localTime2(new Date(input.deadline), (await getSettings(tx)).timezone) } : {},
            updatedAt: now
          }).where(eq(taskSeries.id, task.seriesId));
          await tx.update(tasks).set(futurePatch).where(
            and(
              eq(tasks.seriesId, task.seriesId),
              gte(tasks.occurrenceDate, task.occurrenceDate),
              eq(tasks.status, "pending")
            )
          );
          if (input.deadline) {
            const settings = await getSettings(tx);
            const deadlineTime = localTime2(new Date(input.deadline), settings.timezone);
            const futureTasks = await tx.query.tasks.findMany({
              where: and(
                eq(tasks.seriesId, task.seriesId),
                gte(tasks.occurrenceDate, task.occurrenceDate),
                eq(tasks.status, "pending")
              )
            });
            for (const futureTask of futureTasks) {
              if (!futureTask.occurrenceDate) continue;
              await tx.update(tasks).set({
                deadlineAt: localDateTime(futureTask.occurrenceDate, deadlineTime, settings.timezone),
                updatedAt: now
              }).where(eq(tasks.id, futureTask.id));
            }
          }
        }
        await audit(tx, actor, "task.edited", "task", task.id, `Edited task \u201C${task.title}\u201D`, { scope: input.scope });
        return { task_id: task.id, status: task.status, updated: true };
      }
      if (input.action === "cancel" || input.action === "fail") {
        assertState(
          task.status === "pending" || task.status === "submitted",
          "task_final",
          "This task already has a final status"
        );
        const status = input.action === "fail" ? "failed" : "cancelled";
        await tx.update(tasks).set({ status, failureReason: input.reason, updatedAt: now }).where(eq(tasks.id, task.id));
        if (task.status === "submitted") {
          await tx.update(taskSubmissions).set({ status: "rejected", reviewedAt: now, reviewReason: input.reason }).where(and(eq(taskSubmissions.taskId, task.id), eq(taskSubmissions.status, "pending")));
        }
        let penalty = 0;
        if (input.action === "fail") penalty = await applyPenalty(tx, task, actor, input.reason);
        if (input.scope === "this_and_future" && task.seriesId) {
          await tx.update(taskSeries).set({ active: false, updatedAt: now }).where(eq(taskSeries.id, task.seriesId));
          await tx.update(tasks).set({ status: "cancelled", failureReason: input.reason, updatedAt: now }).where(and(eq(tasks.seriesId, task.seriesId), gte(tasks.occurrenceDate, task.occurrenceDate), eq(tasks.status, "pending")));
        }
        await audit(tx, actor, `task.${status}`, "task", task.id, input.reason, { scope: input.scope, penalty });
        await recomputeActivityAndStats(tx);
        return { task_id: task.id, status, penalty };
      }
      assertState(input.action === "review", "invalid_action", "Task action is invalid");
      assertState(task.status === "submitted", "task_not_submitted", "This task has no pending submission");
      const submission = assertFound(
        await tx.query.taskSubmissions.findFirst({
          where: and(eq(taskSubmissions.taskId, task.id), eq(taskSubmissions.status, "pending")),
          orderBy: [desc(taskSubmissions.attempt)]
        }),
        "Submission not found"
      );
      if (input.decision === "approve") {
        const settings = await getSettings(tx);
        const completionDate = localDate(submission.submittedAt, settings.timezone);
        await tx.update(taskSubmissions).set({ status: "approved", reviewedAt: now, reviewReason: input.reason }).where(eq(taskSubmissions.id, submission.id));
        await completeTask(tx, task, completionDate, actor);
        await recomputeActivityAndStats(tx);
        return { task_id: task.id, status: "completed", completion_date: completionDate };
      }
      await tx.update(taskSubmissions).set({ status: "rejected", reviewedAt: now, reviewReason: input.reason }).where(eq(taskSubmissions.id, submission.id));
      await tx.update(tasks).set({
        status: "pending",
        submittedAt: null,
        deadlineAt: task.deadlineAt && task.deadlineAt <= now ? null : task.deadlineAt,
        updatedAt: now
      }).where(eq(tasks.id, task.id));
      await audit(tx, actor, "submission.rejected", "task", task.id, input.reason ?? "Submission rejected");
      return { task_id: task.id, status: "pending", rejected: true };
    });
  });
}
async function submitTask(taskId, proofText, storedProofs, actor = "user") {
  return getDb().transaction(async (tx) => {
    await reconcileInTransaction(tx);
    const task = assertFound(await tx.query.tasks.findFirst({ where: eq(tasks.id, taskId) }), "Task not found");
    assertState(task.status === "pending", "task_not_pending", "Only a pending task can be submitted");
    const hasText = proofText.trim().length > 0;
    const hasImage = storedProofs.length > 0;
    const validProof = task.proofRequirement === "none" || task.proofRequirement === "text" && hasText || task.proofRequirement === "image" && hasImage || task.proofRequirement === "text_or_image" && (hasText || hasImage) || task.proofRequirement === "text_and_image" && hasText && hasImage;
    assertState(validProof, "proof_required", `This task requires proof: ${task.proofRequirement}`);
    const [{ value: attempts }] = await tx.select({ value: sql3`count(*)` }).from(taskSubmissions).where(eq(taskSubmissions.taskId, task.id));
    const submissionId = createId("submission");
    const now = /* @__PURE__ */ new Date();
    await tx.insert(taskSubmissions).values({
      id: submissionId,
      taskId: task.id,
      attempt: Number(attempts ?? 0) + 1,
      proofText,
      status: task.verificationMode === "self" ? "approved" : "pending",
      submittedAt: now,
      reviewedAt: task.verificationMode === "self" ? now : null
    });
    if (storedProofs.length) {
      await tx.insert(proofAssets).values(
        storedProofs.map((proof) => ({
          ...proof,
          submissionId
        }))
      );
    }
    if (task.verificationMode === "self") {
      const settings = await getSettings(tx);
      await completeTask(tx, task, localDate(now, settings.timezone), actor);
      await recomputeActivityAndStats(tx);
      return { task_id: task.id, submission_id: submissionId, status: "completed" };
    }
    await tx.update(tasks).set({ status: "submitted", submittedAt: now, updatedAt: now }).where(eq(tasks.id, task.id));
    await audit(tx, actor, "submission.created", "task", task.id, `Submitted proof for \u201C${task.title}\u201D`);
    return { task_id: task.id, submission_id: submissionId, status: "submitted" };
  });
}
async function getOverview() {
  await reconcileSystem();
  const db = getDb();
  const settings = await getSettings(db);
  const stats = assertFound(await db.query.statistics.findFirst({ where: eq(statistics.id, 1) }));
  const today = localDate(/* @__PURE__ */ new Date(), settings.timezone);
  const [counts] = await db.select({
    pending: sql3`count(*) filter (where ${tasks.status} = 'pending' and (${visibleTaskCondition(/* @__PURE__ */ new Date())}))`,
    submitted: sql3`count(*) filter (where ${tasks.status} = 'submitted')`,
    completedToday: sql3`count(*) filter (where ${tasks.completionDate} = ${today})`
  }).from(tasks);
  const [{ value: pendingRedemptions }] = await db.select({ value: sql3`count(*)` }).from(redemptions).where(eq(redemptions.status, "pending"));
  const recentUnlocks = await db.query.achievementUnlocks.findMany({
    orderBy: [desc(achievementUnlocks.unlockedAt)],
    limit: 5,
    with: { achievement: true }
  });
  return {
    statistics: stats,
    today: {
      date: today,
      completed: Number(counts?.completedToday ?? 0),
      active: Number(counts?.completedToday ?? 0) > 0
    },
    queues: {
      pending_tasks: Number(counts?.pending ?? 0),
      awaiting_review: Number(counts?.submitted ?? 0),
      pending_redemptions: Number(pendingRedemptions ?? 0)
    },
    recent_achievements: recentUnlocks,
    labels: { user: settings.userLabel, ai: settings.aiLabel },
    timezone: settings.timezone,
    boundaries: {
      allowed_content: settings.allowedContent,
      prohibited_content: settings.prohibitedContent,
      punishment_intensity: settings.punishmentIntensity,
      daily_penalty_limit: settings.dailyPenaltyLimit,
      punishments_paused: settings.punishmentsPaused,
      notes: settings.boundaryNotes,
      version: settings.boundaryVersion
    }
  };
}
async function queryHistory(input) {
  await reconcileSystem();
  const db = getDb();
  const limit = Math.min(input.limit ?? 30, 100);
  const kind = input.kind ?? "all";
  const result2 = {};
  if (kind === "all" || kind === "tasks") {
    result2.tasks = await db.query.tasks.findMany({
      where: inArray(tasks.status, ["completed", "failed", "expired", "cancelled"]),
      orderBy: [desc(tasks.updatedAt)],
      limit
    });
  }
  if (kind === "all" || kind === "points") {
    result2.points = await db.query.pointLedger.findMany({ orderBy: [desc(pointLedger.createdAt)], limit });
  }
  if (kind === "all" || kind === "redemptions") {
    result2.redemptions = await db.query.redemptions.findMany({
      orderBy: [desc(redemptions.redeemedAt)],
      limit,
      with: { rewardItem: true }
    });
  }
  if (kind === "all" || kind === "audit") {
    result2.audit = await db.query.auditLogs.findMany({ orderBy: [desc(auditLogs.createdAt)], limit });
  }
  return result2;
}
async function manageRewards(input, actor = "AI") {
  const db = getDb();
  if (input.action === "list") {
    return db.query.rewardItems.findMany({
      where: input.include_archived ? void 0 : eq(rewardItems.active, true),
      orderBy: [asc(rewardItems.sortOrder), asc(rewardItems.createdAt)]
    });
  }
  if (input.action === "list_redemptions") {
    return db.query.redemptions.findMany({
      where: input.status ? eq(redemptions.status, input.status) : void 0,
      orderBy: [desc(redemptions.redeemedAt)],
      with: { rewardItem: true }
    });
  }
  return db.transaction(
    async (tx) => idempotent(tx, "manage_rewards", input.idempotency_key, async () => {
      if (input.action === "create") {
        const id = createId("reward");
        const [reward] = await tx.insert(rewardItems).values({ id, name: input.name, description: input.description, cost: input.cost }).returning();
        await audit(tx, actor, "reward.created", "reward", id, `Created reward \u201C${input.name}\u201D`);
        return { reward };
      }
      if (input.action === "update") {
        const reward = assertFound(
          await tx.query.rewardItems.findFirst({ where: eq(rewardItems.id, input.reward_id) }),
          "Reward not found"
        );
        const [updated] = await tx.update(rewardItems).set({
          name: input.name ?? reward.name,
          description: input.description ?? reward.description,
          cost: input.cost ?? reward.cost,
          updatedAt: /* @__PURE__ */ new Date()
        }).where(eq(rewardItems.id, reward.id)).returning();
        await audit(tx, actor, "reward.updated", "reward", reward.id, `Updated reward \u201C${reward.name}\u201D`);
        return { reward: updated };
      }
      if (input.action === "archive") {
        const reward = assertFound(
          await tx.query.rewardItems.findFirst({ where: eq(rewardItems.id, input.reward_id) }),
          "Reward not found"
        );
        await tx.update(rewardItems).set({ active: false, updatedAt: /* @__PURE__ */ new Date() }).where(eq(rewardItems.id, reward.id));
        await audit(tx, actor, "reward.archived", "reward", reward.id, `Archived reward \u201C${reward.name}\u201D`);
        return { reward_id: reward.id, active: false };
      }
      const redemption = assertFound(
        await tx.query.redemptions.findFirst({ where: eq(redemptions.id, input.redemption_id) }),
        "Redemption not found"
      );
      assertState(redemption.status === "pending", "redemption_final", "Redemption is already finalized");
      await tx.update(redemptions).set({ status: "fulfilled", fulfilledAt: /* @__PURE__ */ new Date(), fulfillmentNote: input.note }).where(eq(redemptions.id, redemption.id));
      await audit(tx, actor, "redemption.fulfilled", "redemption", redemption.id, input.note ?? "Reward fulfilled");
      await recomputeActivityAndStats(tx);
      return { redemption_id: redemption.id, status: "fulfilled" };
    })
  );
}
async function redeemReward(rewardId, idempotencyKey) {
  return getDb().transaction(
    async (tx) => idempotent(tx, "redeem_reward", idempotencyKey, async () => {
      const reward = assertFound(
        await tx.query.rewardItems.findFirst({ where: and(eq(rewardItems.id, rewardId), eq(rewardItems.active, true)) }),
        "Reward not found"
      );
      const balance = await currentBalance(tx);
      assertState(balance >= reward.cost, "insufficient_points", "Not enough points for this reward");
      const id = createId("redemption");
      const [redemption] = await tx.insert(redemptions).values({
        id,
        rewardItemId: reward.id,
        itemNameSnapshot: reward.name,
        costSnapshot: reward.cost,
        idempotencyKey
      }).returning();
      await addLedger(tx, {
        type: "redemption",
        amount: -reward.cost,
        key: `redemption:${id}`,
        reason: `Redeemed: ${reward.name}`,
        redemptionId: id
      });
      await audit(tx, "user", "reward.redeemed", "redemption", id, `Redeemed \u201C${reward.name}\u201D`, { cost: reward.cost });
      await recomputeActivityAndStats(tx);
      return { redemption, balance: balance - reward.cost };
    })
  );
}
async function adjustPoints(input, actor = "AI") {
  return getDb().transaction(
    async (tx) => idempotent(tx, "adjust_points", input.idempotency_key, async () => {
      const settings = await getSettings(tx);
      const today = localDate(/* @__PURE__ */ new Date(), settings.timezone);
      let amount = input.amount;
      let type = "manual_bonus";
      if (input.kind === "penalty") {
        assertState(!settings.punishmentsPaused, "punishments_paused", "Point penalties are paused by the user");
        const [{ value: usedToday }] = await tx.select({ value: sql3`coalesce(sum(-${pointLedger.amount}), 0)` }).from(pointLedger).where(and(eq(pointLedger.type, "manual_penalty"), eq(pointLedger.effectiveDate, today)));
        const remaining = Math.max(0, settings.dailyPenaltyLimit - Number(usedToday ?? 0));
        assertState(remaining > 0, "daily_penalty_limit", "The user's daily penalty limit has been reached");
        amount = -Math.min(input.amount, remaining, Math.max(0, await currentBalance(tx)));
        type = "manual_penalty";
      } else if (input.kind === "correction") {
        type = "correction";
      }
      const entry = await addLedger(tx, {
        type,
        amount,
        key: `manual:${input.idempotency_key}`,
        reason: input.reason,
        taskId: input.related_task_id,
        effectiveDate: today
      });
      await audit(tx, actor, `points.${input.kind}`, "point_ledger", entry.id, input.reason, { amount });
      await recomputeActivityAndStats(tx);
      return { entry, balance: await currentBalance(tx) };
    })
  );
}
async function listAchievements() {
  await reconcileSystem();
  const db = getDb();
  return db.query.achievements.findMany({
    orderBy: [asc(achievements.sortOrder)],
    with: { unlocks: true }
  });
}
async function getPublicSettings() {
  const settings = await getSettings(getDb());
  return {
    initialized: settings.initialized,
    timezone: settings.timezone,
    user_label: settings.userLabel,
    ai_label: settings.aiLabel
  };
}
async function getUserSettings() {
  const settings = await getSettings(getDb());
  return {
    timezone: settings.timezone,
    user_label: settings.userLabel,
    ai_label: settings.aiLabel,
    allowed_content: settings.allowedContent,
    prohibited_content: settings.prohibitedContent,
    punishment_intensity: settings.punishmentIntensity,
    daily_penalty_limit: settings.dailyPenaltyLimit,
    punishments_paused: settings.punishmentsPaused,
    boundary_notes: settings.boundaryNotes,
    boundary_version: settings.boundaryVersion,
    updated_at: settings.updatedAt
  };
}
async function updateUserSettings(input) {
  return getDb().transaction(async (tx) => {
    const previous = await getSettings(tx);
    const boundaryChanged = JSON.stringify(previous.allowedContent) !== JSON.stringify(input.allowed_content) || JSON.stringify(previous.prohibitedContent) !== JSON.stringify(input.prohibited_content) || previous.punishmentIntensity !== input.punishment_intensity || previous.dailyPenaltyLimit !== input.daily_penalty_limit || previous.punishmentsPaused !== input.punishments_paused || previous.boundaryNotes !== input.boundary_notes;
    await tx.update(appSettings).set({
      timezone: input.timezone,
      userLabel: input.user_label,
      aiLabel: input.ai_label,
      allowedContent: input.allowed_content,
      prohibitedContent: input.prohibited_content,
      punishmentIntensity: input.punishment_intensity,
      dailyPenaltyLimit: input.daily_penalty_limit,
      punishmentsPaused: input.punishments_paused,
      boundaryNotes: input.boundary_notes,
      boundaryVersion: boundaryChanged ? previous.boundaryVersion + 1 : previous.boundaryVersion,
      updatedAt: /* @__PURE__ */ new Date()
    }).where(eq(appSettings.id, 1));
    await audit(tx, "user", "settings.updated", "settings", "1", "User settings updated", {
      boundaryChanged
    });
    await recomputeActivityAndStats(tx);
    const updated = await getSettings(tx);
    return {
      timezone: updated.timezone,
      user_label: updated.userLabel,
      ai_label: updated.aiLabel,
      allowed_content: updated.allowedContent,
      prohibited_content: updated.prohibitedContent,
      punishment_intensity: updated.punishmentIntensity,
      daily_penalty_limit: updated.dailyPenaltyLimit,
      punishments_paused: updated.punishmentsPaused,
      boundary_notes: updated.boundaryNotes,
      boundary_version: updated.boundaryVersion,
      updated_at: updated.updatedAt
    };
  });
}

// src/server/services/storage.ts
import fs2 from "node:fs/promises";
import path3 from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import sharp from "sharp";
var s3 = config.STORAGE_DRIVER === "s3" ? new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY
  }
}) : null;
async function initializeStorage() {
  if (!s3) {
    await fs2.mkdir(config.LOCAL_STORAGE_PATH, { recursive: true });
    return;
  }
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status !== 404 && error?.name !== "NotFound" && error?.name !== "NoSuchBucket") throw error;
    await s3.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
  }
}
async function putObject(key, body, contentType) {
  if (s3) {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: "private, max-age=86400"
      })
    );
    return;
  }
  const target = path3.join(config.LOCAL_STORAGE_PATH, ...key.split("/"));
  await fs2.mkdir(path3.dirname(target), { recursive: true });
  await fs2.writeFile(target, body, { flag: "wx" });
}
async function putRestoredObject(key, body, contentType = "image/webp") {
  await putObject(key, body, contentType);
}
async function getObject(key) {
  if (s3) {
    const response = await s3.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    if (!response.Body) throw new AppError(404, "asset_not_found", "Proof image not found");
    return Buffer.from(await response.Body.transformToByteArray());
  }
  try {
    return await fs2.readFile(path3.join(config.LOCAL_STORAGE_PATH, ...key.split("/")));
  } catch {
    throw new AppError(404, "asset_not_found", "Proof image not found");
  }
}
async function deleteObject(key) {
  if (s3) {
    await s3.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    return;
  }
  await fs2.rm(path3.join(config.LOCAL_STORAGE_PATH, ...key.split("/")), { force: true });
}
async function saveProofImages(files) {
  if (files.length > MAX_PROOF_IMAGES) {
    throw new AppError(413, "too_many_images", `A submission can contain at most ${MAX_PROOF_IMAGES} images`);
  }
  const stored = [];
  try {
    for (const file of files) {
      if (file.size > MAX_PROOF_IMAGE_BYTES) {
        throw new AppError(413, "image_too_large", "Each proof image must be 10 MB or smaller");
      }
      const image = sharp(file.buffer, {
        failOn: "warning",
        limitInputPixels: MAX_PROOF_IMAGE_PIXELS
      });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) {
        throw new AppError(415, "unsupported_image", "Only genuine JPEG, PNG, and WebP images are accepted");
      }
      if (metadata.width * metadata.height > MAX_PROOF_IMAGE_PIXELS) {
        throw new AppError(413, "image_dimensions_too_large", "Image pixel dimensions are too large");
      }
      const normalized = await image.rotate().webp({ quality: 90, effort: 4 }).toBuffer();
      const preview = await sharp(normalized).resize({ width: 1440, height: 1440, fit: "inside", withoutEnlargement: true }).webp({ quality: 78, effort: 4 }).toBuffer();
      const id = createId("proof");
      const objectKey = `proofs/${id}/original.webp`;
      const previewKey = `proofs/${id}/preview.webp`;
      await putObject(objectKey, normalized, "image/webp");
      await putObject(previewKey, preview, "image/webp");
      stored.push({
        id,
        objectKey,
        previewKey,
        mimeType: "image/webp",
        sizeBytes: normalized.byteLength,
        sha256: sha256(normalized),
        width: metadata.autoOrient?.width ?? metadata.width,
        height: metadata.autoOrient?.height ?? metadata.height
      });
    }
    return stored;
  } catch (error) {
    await Promise.allSettled(stored.flatMap((item) => [deleteObject(item.objectKey), deleteObject(item.previewKey)]));
    throw error;
  }
}
async function removeStoredProofs(items) {
  await Promise.allSettled(items.flatMap((item) => [deleteObject(item.objectKey), deleteObject(item.previewKey)]));
}

// src/server/mcp.ts
function result(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: { result: data }
  };
}
async function taskResultWithProofImages(data) {
  const content = [{ type: "text", text: JSON.stringify(data, null, 2) }];
  const assets = (data.items ?? []).flatMap((task) => task.submissions ?? []).flatMap((submission) => submission.assets ?? []).slice(0, 12);
  for (const asset of assets) {
    const preview = await getObject(asset.previewKey);
    content.push({ type: "image", data: preview.toString("base64"), mimeType: asset.mimeType });
  }
  return { content, structuredContent: { result: data } };
}
function createMcpServer() {
  const server2 = new McpServer(
    { name: "Phosphene", version: "1.0.0" },
    { capabilities: { logging: {} } }
  );
  server2.tool(
    "create_task",
    "Create a one-time task or a recurring daily task for the user. Respect the user's configured boundaries.",
    {
      title: z3.string().min(1).max(120),
      description: z3.string().max(4e3).optional(),
      type: z3.enum(TASK_TYPES),
      difficulty: z3.enum(TASK_DIFFICULTIES).default("easy"),
      base_points: z3.number().int().min(1).max(1e4),
      verification_mode: z3.enum(VERIFICATION_MODES).default("self"),
      proof_requirement: z3.enum(PROOF_REQUIREMENTS).default("none"),
      recurrence: z3.enum(RECURRENCE_MODES).default("once"),
      start_date: z3.string().optional(),
      end_date: z3.string().optional(),
      daily_deadline_time: z3.string().default("23:59"),
      deadline: z3.string().optional(),
      reveal_mode: z3.enum(REVEAL_MODES).default("immediate"),
      visible_at: z3.string().optional(),
      related_task_id: z3.string().optional(),
      idempotency_key: z3.string().min(8).max(128)
    },
    async (args) => result(await createTask(createTaskSchema.parse(args), "AI"))
  );
  server2.tool(
    "query_tasks",
    "Find tasks and, when requested, their proof submissions. Hidden surprises are visible to AI.",
    {
      task_id: z3.string().optional(),
      status: z3.enum(TASK_STATUSES).optional(),
      type: z3.enum(TASK_TYPES).optional(),
      from: z3.string().optional(),
      to: z3.string().optional(),
      include_proof: z3.boolean().default(false),
      limit: z3.number().int().min(1).max(100).default(30),
      cursor: z3.string().optional()
    },
    async (args) => {
      const input = taskQuerySchema.parse(args);
      const data = await queryTasks(input, "AI");
      return input.include_proof ? taskResultWithProofImages(data) : result(data);
    }
  );
  server2.tool(
    "manage_task",
    "Edit, cancel, fail, review, pause, or resume a task/series. Use an idempotency key for every write.",
    {
      action: z3.enum(["edit", "cancel", "fail", "review", "pause_series", "resume_series"]),
      task_id: z3.string().optional(),
      series_id: z3.string().optional(),
      scope: z3.enum(["occurrence", "this_and_future"]).optional(),
      title: z3.string().optional(),
      description: z3.string().optional(),
      difficulty: z3.enum(TASK_DIFFICULTIES).optional(),
      base_points: z3.number().int().optional(),
      deadline: z3.string().optional(),
      decision: z3.enum(["approve", "reject"]).optional(),
      reason: z3.string().optional(),
      idempotency_key: z3.string().min(8).max(128)
    },
    async (args) => result(await manageTask(manageTaskSchema.parse(args), "AI"))
  );
  server2.tool(
    "get_overview",
    "Get balance, streaks, lifetime statistics, today's state, queues, labels, timezone, and recent achievements.",
    {},
    async () => result(await getOverview())
  );
  server2.tool(
    "query_history",
    "Query completed/final tasks, point ledger, redemptions, or audit history.",
    {
      kind: z3.enum(["all", "tasks", "points", "redemptions", "audit"]).default("all"),
      limit: z3.number().int().min(1).max(100).default(30)
    },
    async (args) => result(await queryHistory(args))
  );
  server2.tool(
    "manage_rewards",
    "List and configure reward items or fulfill a user's redemption. AI cannot redeem on the user's behalf.",
    {
      action: z3.enum(["list", "create", "update", "archive", "list_redemptions", "fulfill_redemption"]),
      include_archived: z3.boolean().optional(),
      name: z3.string().optional(),
      description: z3.string().optional(),
      cost: z3.number().int().optional(),
      reward_id: z3.string().optional(),
      status: z3.enum(["pending", "fulfilled", "cancelled"]).optional(),
      redemption_id: z3.string().optional(),
      note: z3.string().optional(),
      idempotency_key: z3.string().optional()
    },
    async (args) => result(await manageRewards(rewardManageSchema.parse(args), "AI"))
  );
  server2.tool(
    "adjust_points",
    "Grant a bonus, apply a penalty within the user's daily limit, or record a correction.",
    {
      kind: z3.enum(["bonus", "penalty", "correction"]),
      amount: z3.number().int().min(-1e5).max(1e5).refine((value) => value !== 0),
      reason: z3.string().min(1).max(1e3),
      related_task_id: z3.string().optional(),
      idempotency_key: z3.string().min(8).max(128)
    },
    async (args) => result(await adjustPoints(adjustPointsSchema.parse(args), "AI"))
  );
  return server2;
}
async function handleMcp(request, response) {
  const server2 = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: void 0 });
  response.on("close", () => {
    void transport.close();
    void server2.close();
  });
  await server2.connect(transport);
  await transport.handleRequest(request, response, request.body);
}

// src/server/routes.ts
import { eq as eq4 } from "drizzle-orm";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { z as z4 } from "zod";

// src/server/services/auth.ts
import argon2 from "argon2";
import { and as and2, eq as eq2, gt, isNull as isNull2 } from "drizzle-orm";
var SESSION_COOKIE = "phosphene_session";
var CSRF_COOKIE = "phosphene_csrf";
var sessionLifetimeMs = 30 * 24 * 60 * 60 * 1e3;
var sessionCookieOptions = {
  httpOnly: true,
  sameSite: "strict",
  secure: config.NODE_ENV === "production",
  path: "/",
  maxAge: sessionLifetimeMs
};
var csrfCookieOptions = {
  httpOnly: false,
  sameSite: "strict",
  secure: config.NODE_ENV === "production",
  path: "/",
  maxAge: sessionLifetimeMs
};
async function issueSession(response, database2 = getDb()) {
  const rawToken = createSecret();
  const csrfToken = createSecret(24);
  const sessionId = createId("session");
  await database2.insert(sessions).values({
    id: sessionId,
    tokenHash: tokenHash(rawToken),
    csrfTokenHash: tokenHash(csrfToken),
    expiresAt: new Date(Date.now() + sessionLifetimeMs)
  });
  response.cookie(SESSION_COOKIE, rawToken, sessionCookieOptions);
  response.cookie(CSRF_COOKIE, csrfToken, csrfCookieOptions);
  return { csrf_token: csrfToken };
}
async function setupApplication(values, response) {
  assertState(values.setup_token === config.PHOSPHENE_SETUP_TOKEN, "invalid_setup_token", "Setup token is invalid");
  const db = getDb();
  return db.transaction(async (tx) => {
    const settings = assertFound(await tx.query.appSettings.findFirst({ where: eq2(appSettings.id, 1) }));
    assertState(!settings.initialized, "already_initialized", "Phosphene has already been set up");
    const passwordHash = await argon2.hash(values.password, { type: argon2.argon2id });
    await tx.insert(userAccount).values({ id: 1, passwordHash });
    await tx.update(appSettings).set({
      initialized: true,
      timezone: values.timezone,
      userLabel: values.user_label,
      aiLabel: values.ai_label,
      updatedAt: /* @__PURE__ */ new Date()
    }).where(eq2(appSettings.id, 1));
    const aiToken = `phosphene_ai_${createSecret(32)}`;
    const aiTokenId = createId("aitoken");
    await tx.insert(aiTokens).values({
      id: aiTokenId,
      tokenHash: tokenHash(aiToken),
      name: "Primary AI"
    });
    await tx.insert(auditLogs).values({
      id: createId("audit"),
      actor: "user",
      action: "application.setup",
      entityType: "application",
      summary: "Phosphene initialized"
    });
    const session = await issueSession(response, tx);
    return {
      ...session,
      ai_token: aiToken,
      ai_token_id: aiTokenId,
      warning: "This AI token is shown once. Store it somewhere safe."
    };
  });
}
async function login(password, response) {
  const db = getDb();
  const account = assertFound(await db.query.userAccount.findFirst({ where: eq2(userAccount.id, 1) }), "Account not initialized");
  const valid = await argon2.verify(account.passwordHash, password);
  if (!valid) throw new AppError(401, "invalid_credentials", "Password is incorrect");
  return issueSession(response);
}
async function logout(request, response) {
  const raw = request.cookies?.[SESSION_COOKIE];
  if (raw) {
    await getDb().update(sessions).set({ revokedAt: /* @__PURE__ */ new Date() }).where(eq2(sessions.tokenHash, tokenHash(raw)));
  }
  response.clearCookie(SESSION_COOKIE, { path: "/" });
  response.clearCookie(CSRF_COOKIE, { path: "/" });
}
async function requireUser(request, _response, next) {
  try {
    const raw = request.cookies?.[SESSION_COOKIE];
    if (!raw) throw new AppError(401, "authentication_required", "Please sign in");
    const session = await getDb().query.sessions.findFirst({
      where: and2(
        eq2(sessions.tokenHash, tokenHash(raw)),
        isNull2(sessions.revokedAt),
        gt(sessions.expiresAt, /* @__PURE__ */ new Date())
      )
    });
    if (!session) throw new AppError(401, "session_expired", "Your session has expired");
    request.phospheneSession = session;
    request.phospheneActor = "user";
    next();
  } catch (error) {
    next(error);
  }
}
function requireCsrf(request, _response, next) {
  try {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
    const csrf = request.get("x-csrf-token");
    const cookie = request.cookies?.[CSRF_COOKIE];
    if (!csrf || !cookie || csrf !== cookie || !request.phospheneSession || tokenHash(csrf) !== request.phospheneSession.csrfTokenHash) {
      throw new AppError(403, "csrf_failed", "Security token is missing or invalid");
    }
    next();
  } catch (error) {
    next(error);
  }
}
async function requireAi(request, _response, next) {
  try {
    const authorization = request.get("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new AppError(401, "ai_token_required", "AI bearer token is required");
    const raw = authorization.slice(7);
    const token = await getDb().query.aiTokens.findFirst({
      where: and2(eq2(aiTokens.tokenHash, tokenHash(raw)), isNull2(aiTokens.revokedAt))
    });
    if (!token) throw new AppError(401, "invalid_ai_token", "AI token is invalid or revoked");
    await getDb().update(aiTokens).set({ lastUsedAt: /* @__PURE__ */ new Date() }).where(eq2(aiTokens.id, token.id));
    request.phospheneActor = "AI";
    next();
  } catch (error) {
    next(error);
  }
}
async function rotateAiToken(name = "Primary AI") {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.update(aiTokens).set({ revokedAt: /* @__PURE__ */ new Date() }).where(isNull2(aiTokens.revokedAt));
    const raw = `phosphene_ai_${createSecret(32)}`;
    const id = createId("aitoken");
    await tx.insert(aiTokens).values({ id, name, tokenHash: tokenHash(raw) });
    await tx.insert(auditLogs).values({
      id: createId("audit"),
      actor: "user",
      action: "ai_token.rotated",
      entityType: "ai_token",
      entityId: id,
      summary: "AI access token rotated"
    });
    return { id, token: raw, warning: "This token is shown once." };
  });
}
async function listAiTokens() {
  return getDb().query.aiTokens.findMany({
    columns: { id: true, name: true, createdAt: true, lastUsedAt: true, revokedAt: true }
  });
}
async function changePassword(currentPassword, newPassword) {
  const db = getDb();
  const account = assertFound(await db.query.userAccount.findFirst({ where: eq2(userAccount.id, 1) }));
  if (!await argon2.verify(account.passwordHash, currentPassword)) {
    throw new AppError(401, "invalid_credentials", "Current password is incorrect");
  }
  const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
  await db.transaction(async (tx) => {
    await tx.update(userAccount).set({ passwordHash, passwordChangedAt: /* @__PURE__ */ new Date(), updatedAt: /* @__PURE__ */ new Date() }).where(eq2(userAccount.id, 1));
    await tx.update(sessions).set({ revokedAt: /* @__PURE__ */ new Date() }).where(isNull2(sessions.revokedAt));
  });
}
async function verifyPassword(password) {
  const account = assertFound(
    await getDb().query.userAccount.findFirst({ where: eq2(userAccount.id, 1) }),
    "Account not initialized"
  );
  if (!await argon2.verify(account.passwordHash, password)) {
    throw new AppError(401, "invalid_credentials", "Password is incorrect");
  }
}

// src/server/services/backup.ts
import JSZip from "jszip";
import { eq as eq3 } from "drizzle-orm";
var timestampFields = /* @__PURE__ */ new Set([
  "createdAt",
  "updatedAt",
  "visibleAt",
  "revealedAt",
  "deadlineAt",
  "submittedAt",
  "completedAt",
  "expiredAt",
  "reviewedAt",
  "redeemedAt",
  "fulfilledAt",
  "unlockedAt"
]);
function reviveRows(rows) {
  return rows.map(
    (row) => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value != null && timestampFields.has(key) ? new Date(String(value)) : value
      ])
    )
  );
}
async function exportBackup() {
  const db = getDb();
  const data = {
    settings: await db.select().from(appSettings),
    taskSeries: await db.select().from(taskSeries),
    tasks: await db.select().from(tasks),
    taskSubmissions: await db.select().from(taskSubmissions),
    proofAssets: await db.select().from(proofAssets),
    rewardItems: await db.select().from(rewardItems),
    redemptions: await db.select().from(redemptions),
    pointLedger: await db.select().from(pointLedger),
    dailyActivity: await db.select().from(dailyActivity),
    statistics: await db.select().from(statistics),
    achievementUnlocks: await db.select().from(achievementUnlocks),
    auditLogs: await db.select().from(auditLogs)
  };
  const zip = new JSZip();
  zip.file(
    "phosphene-backup.json",
    JSON.stringify(
      {
        format: "phosphene-backup",
        version: 1,
        exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
        data
      },
      null,
      2
    )
  );
  for (const asset of data.proofAssets) {
    zip.file(`objects/${asset.objectKey}`, await getObject(asset.objectKey));
    zip.file(`objects/${asset.previewKey}`, await getObject(asset.previewKey));
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    streamFiles: true
  });
}
async function restoreBackup(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch {
    throw new AppError(400, "invalid_backup", "The selected file is not a valid Phosphene backup");
  }
  const manifestFile = zip.file("phosphene-backup.json");
  if (!manifestFile) throw new AppError(400, "invalid_backup", "Backup manifest is missing");
  const manifest = JSON.parse(await manifestFile.async("string"));
  if (manifest.format !== "phosphene-backup" || manifest.version !== 1 || !manifest.data) {
    throw new AppError(400, "unsupported_backup", "This backup format is not supported");
  }
  const data = manifest.data;
  const required = [
    "settings",
    "taskSeries",
    "tasks",
    "taskSubmissions",
    "proofAssets",
    "rewardItems",
    "redemptions",
    "pointLedger",
    "dailyActivity",
    "statistics",
    "achievementUnlocks",
    "auditLogs"
  ];
  if (!required.every((key) => Array.isArray(data[key]))) {
    throw new AppError(400, "invalid_backup", "Backup data is incomplete");
  }
  const incomingProofs = reviveRows(data.proofAssets);
  for (const proof of incomingProofs) {
    const original = zip.file(`objects/${proof.objectKey}`);
    const preview = zip.file(`objects/${proof.previewKey}`);
    if (!original || !preview) throw new AppError(400, "invalid_backup", "Backup proof images are incomplete");
    await putRestoredObject(proof.objectKey, await original.async("nodebuffer"));
    await putRestoredObject(proof.previewKey, await preview.async("nodebuffer"));
  }
  const db = getDb();
  const oldProofs = await db.select().from(proofAssets);
  try {
    await db.transaction(async (tx) => {
      await tx.delete(achievementUnlocks);
      await tx.delete(pointLedger);
      await tx.delete(proofAssets);
      await tx.delete(taskSubmissions);
      await tx.delete(tasks);
      await tx.delete(taskSeries);
      await tx.delete(redemptions);
      await tx.delete(rewardItems);
      await tx.delete(dailyActivity);
      await tx.delete(auditLogs);
      const settings = reviveRows(data.settings)[0];
      if (settings) {
        delete settings.id;
        delete settings.initialized;
        delete settings.createdAt;
        await tx.update(appSettings).set(settings).where(eq3(appSettings.id, 1));
      }
      if (data.taskSeries.length) await tx.insert(taskSeries).values(reviveRows(data.taskSeries));
      if (data.tasks.length) await tx.insert(tasks).values(reviveRows(data.tasks));
      if (data.taskSubmissions.length) await tx.insert(taskSubmissions).values(reviveRows(data.taskSubmissions));
      if (data.proofAssets.length) await tx.insert(proofAssets).values(reviveRows(data.proofAssets));
      if (data.rewardItems.length) await tx.insert(rewardItems).values(reviveRows(data.rewardItems));
      if (data.redemptions.length) await tx.insert(redemptions).values(reviveRows(data.redemptions));
      if (data.pointLedger.length) await tx.insert(pointLedger).values(reviveRows(data.pointLedger));
      if (data.dailyActivity.length) await tx.insert(dailyActivity).values(reviveRows(data.dailyActivity));
      const stats = reviveRows(data.statistics)[0];
      if (stats) {
        delete stats.id;
        await tx.update(statistics).set(stats).where(eq3(statistics.id, 1));
      }
      if (data.achievementUnlocks.length) {
        await tx.insert(achievementUnlocks).values(reviveRows(data.achievementUnlocks));
      }
      if (data.auditLogs.length) await tx.insert(auditLogs).values(reviveRows(data.auditLogs));
    });
  } catch (error) {
    await removeStoredProofs(incomingProofs);
    throw error;
  }
  await removeStoredProofs(oldProofs);
  await reconcileSystem();
}

// src/server/routes.ts
var router = Router();
var authLimiter = rateLimit({
  windowMs: 15 * 60 * 1e3,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false
});
var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PROOF_IMAGE_BYTES, files: MAX_PROOF_IMAGES, fields: 10 }
});
var backupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024, files: 1, fields: 3 }
});
function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}
function routeParam(request, name) {
  const value = request.params[name];
  if (Array.isArray(value) || !value) throw new AppError(400, "invalid_route", `Missing route parameter: ${name}`);
  return value;
}
router.get(
  "/bootstrap",
  asyncRoute(async (_request, response) => {
    response.json({ ok: true, data: await getPublicSettings() });
  })
);
router.post(
  "/setup",
  authLimiter,
  asyncRoute(async (request, response) => {
    const input = setupSchema.parse(request.body);
    response.status(201).json({ ok: true, data: await setupApplication(input, response) });
  })
);
router.post(
  "/login",
  authLimiter,
  asyncRoute(async (request, response) => {
    const input = loginSchema.parse(request.body);
    response.json({ ok: true, data: await login(input.password, response) });
  })
);
router.use(requireUser);
router.use(
  asyncRoute(async (request, _response, next) => {
    if (request.method === "GET") await revealNextVisitTasks();
    next();
  })
);
router.use(requireCsrf);
router.get("/me", (_request, response) => {
  response.json({ ok: true, data: { authenticated: true } });
});
router.post(
  "/logout",
  asyncRoute(async (request, response) => {
    await logout(request, response);
    response.json({ ok: true });
  })
);
router.get(
  "/overview",
  asyncRoute(async (_request, response) => {
    response.json({ ok: true, data: await getOverview() });
  })
);
router.get(
  "/tasks",
  asyncRoute(async (request, response) => {
    const input = taskQuerySchema.parse({
      task_id: request.query.task_id,
      status: request.query.status,
      type: request.query.type,
      from: request.query.from,
      to: request.query.to,
      include_proof: request.query.include_proof === "true",
      limit: request.query.limit ? Number(request.query.limit) : 50,
      cursor: request.query.cursor
    });
    response.json({ ok: true, data: await queryTasks(input, "user") });
  })
);
router.get(
  "/tasks/:taskId",
  asyncRoute(async (request, response) => {
    const data = await queryTasks(
      {
        task_id: routeParam(request, "taskId"),
        include_proof: true,
        limit: 1
      },
      "user"
    );
    response.json({ ok: true, data: assertFound(data.items[0], "Task not found") });
  })
);
router.post(
  "/tasks/:taskId/submit",
  upload.array("images", MAX_PROOF_IMAGES),
  asyncRoute(async (request, response) => {
    const input = submitTaskSchema.parse(request.body);
    const files = request.files ?? [];
    const stored = await saveProofImages(files);
    try {
      const result2 = await submitTask(routeParam(request, "taskId"), input.proof_text, stored, "user");
      response.status(201).json({ ok: true, data: result2 });
    } catch (error) {
      await removeStoredProofs(stored);
      throw error;
    }
  })
);
router.get(
  "/proofs/:assetId",
  asyncRoute(async (request, response) => {
    const asset = assertFound(
      await getDb().query.proofAssets.findFirst({ where: eq4(proofAssets.id, routeParam(request, "assetId")) }),
      "Proof image not found"
    );
    const original = request.query.variant === "original";
    const buffer = await getObject(original ? asset.objectKey : asset.previewKey);
    response.set({
      "Content-Type": asset.mimeType,
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff"
    });
    response.send(buffer);
  })
);
router.get(
  "/rewards",
  asyncRoute(async (_request, response) => {
    response.json({
      ok: true,
      data: await manageRewards({ action: "list", include_archived: false }, "user")
    });
  })
);
router.post(
  "/rewards/:rewardId/redeem",
  asyncRoute(async (request, response) => {
    const body = z4.object({ idempotency_key: z4.string().min(8).max(128) }).parse(request.body);
    response.status(201).json({
      ok: true,
      data: await redeemReward(routeParam(request, "rewardId"), body.idempotency_key)
    });
  })
);
router.get(
  "/redemptions",
  asyncRoute(async (_request, response) => {
    response.json({
      ok: true,
      data: await manageRewards({ action: "list_redemptions" }, "user")
    });
  })
);
router.get(
  "/achievements",
  asyncRoute(async (_request, response) => {
    response.json({ ok: true, data: await listAchievements() });
  })
);
router.get(
  "/history",
  asyncRoute(async (request, response) => {
    const kind = z4.enum(["all", "tasks", "points", "redemptions", "audit"]).default("all").parse(request.query.kind);
    const limit = z4.coerce.number().int().min(1).max(100).default(50).parse(request.query.limit);
    response.json({ ok: true, data: await queryHistory({ kind, limit }) });
  })
);
router.get(
  "/settings",
  asyncRoute(async (_request, response) => {
    response.json({ ok: true, data: await getUserSettings() });
  })
);
router.put(
  "/settings",
  asyncRoute(async (request, response) => {
    response.json({ ok: true, data: await updateUserSettings(settingsSchema.parse(request.body)) });
  })
);
router.get(
  "/backup/export",
  asyncRoute(async (_request, response) => {
    const archive = await exportBackup();
    const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    response.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="phosphene-backup-${stamp}.zip"`,
      "Content-Length": String(archive.byteLength),
      "Cache-Control": "no-store"
    });
    response.send(archive);
  })
);
router.post(
  "/backup/restore",
  backupUpload.single("backup"),
  asyncRoute(async (request, response) => {
    const password = z4.string().min(1).max(256).parse(request.body.password);
    if (!request.file) throw new AppError(400, "backup_required", "Select a backup file");
    await verifyPassword(password);
    await restoreBackup(request.file.buffer);
    response.json({ ok: true, data: { restored: true, login_required: false } });
  })
);
router.get(
  "/ai-tokens",
  asyncRoute(async (_request, response) => {
    response.json({ ok: true, data: await listAiTokens() });
  })
);
router.post(
  "/ai-tokens/rotate",
  asyncRoute(async (request, response) => {
    const { name } = z4.object({ name: z4.string().trim().min(1).max(80).default("Primary AI") }).parse(request.body);
    response.status(201).json({ ok: true, data: await rotateAiToken(name) });
  })
);
router.put(
  "/password",
  authLimiter,
  asyncRoute(async (request, response) => {
    const input = z4.object({
      current_password: z4.string().min(1).max(256),
      new_password: z4.string().min(10).max(256)
    }).parse(request.body);
    await changePassword(input.current_password, input.new_password);
    response.json({ ok: true, data: { login_required: true } });
  })
);
function apiErrorHandler(error, _request, response, _next) {
  if (error instanceof z4.ZodError) {
    response.status(400).json({
      ok: false,
      error: { code: "validation_error", message: "The request contains invalid values", details: error.flatten() }
    });
    return;
  }
  if (error instanceof multer.MulterError) {
    response.status(413).json({
      ok: false,
      error: { code: "upload_error", message: error.message }
    });
    return;
  }
  if (error instanceof AppError) {
    response.status(error.status).json({
      ok: false,
      error: { code: error.code, message: error.message, details: error.details }
    });
    return;
  }
  console.error(error);
  response.status(500).json({
    ok: false,
    error: { code: "internal_error", message: "Phosphene encountered an unexpected error" }
  });
}
var routes_default = router;

// src/server/index.ts
var logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "response.headers['set-cookie']"
    ],
    censor: "[redacted]"
  }
});
var app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: config.NODE_ENV === "production" ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    } : false,
    crossOriginResourcePolicy: { policy: "same-origin" }
  })
);
app.use(pinoHttp({ logger }));
app.use(cookieParser(config.SESSION_SECRET));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));
app.get("/healthz", (_request, response) => {
  response.json({ status: "ok", version: "1.0.0" });
});
app.use("/api", routes_default);
app.use("/api", (_request, response) => {
  response.status(404).json({
    ok: false,
    error: { code: "api_not_found", message: "API route not found" }
  });
});
app.all("/mcp", requireAi, async (request, response, next) => {
  if (request.method !== "POST") {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32e3, message: "Method not allowed" },
      id: null
    });
    return;
  }
  try {
    await handleMcp(request, response);
  } catch (error) {
    next(error);
  }
});
if (config.NODE_ENV === "development") {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
} else {
  const webRoot = path4.resolve(path4.dirname(fileURLToPath(import.meta.url)), "../web");
  app.use(express.static(webRoot, { index: false, maxAge: "1y", immutable: true }));
  app.use((_request, response) => {
    response.sendFile(path4.join(webRoot, "index.html"));
  });
}
app.use(apiErrorHandler);
await initializeDatabase();
await initializeStorage();
await seedDatabase();
await reconcileSystem();
var server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, url: config.PUBLIC_URL }, "Phosphene is ready");
});
async function shutdown(signal) {
  logger.info({ signal }, "Shutting down Phosphene");
  server.close(async () => {
    await shutdownDatabase();
    process.exit(0);
  });
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
