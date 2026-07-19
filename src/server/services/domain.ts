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
  sql
} from "drizzle-orm";
import { DIFFICULTY_MULTIPLIER, streakBonusForDay } from "../../shared/constants";
import {
  presentLedgerReason,
  presentRewardItem,
  presentRewardSnapshot
} from "../../shared/rewards";
import type {
  AdjustPointsInput,
  CreateTaskInput,
  ManageTaskInput,
  RewardManageInput,
  TaskQueryInput
} from "../../shared/schemas";
import type { z } from "zod";
import type { settingsSchema } from "../../shared/schemas";
import { config } from "../config";
import { getDb } from "../db/client";
import {
  achievementUnlocks,
  achievements,
  appSettings,
  auditLogs,
  dailyActivity,
  idempotencyKeys,
  pointLedger,
  proofAssets,
  redemptions,
  rewardItems,
  statistics,
  taskSeries,
  taskSubmissions,
  tasks
} from "../db/schema";
import { AppError, assertFound, assertState } from "../errors";
import {
  addCalendarDays,
  compareDates,
  localDate,
  localDateTime,
  localTime as timeInZone,
  yesterday
} from "../lib/dates";
import { createId } from "../lib/ids";
import type { StoredProof } from "./storage";

type Db = any;
type Actor = "AI" | "user" | "system";

function presentRedemption(row: any, aiLabel: string) {
  return {
    ...row,
    itemNameSnapshot: presentRewardSnapshot(row.itemNameSnapshot, aiLabel),
    rewardItem: row.rewardItem ? presentRewardItem(row.rewardItem, aiLabel) : row.rewardItem
  };
}

async function getSettings(tx: Db) {
  return assertFound(
    await tx.query.appSettings.findFirst({ where: eq(appSettings.id, 1) }),
    "Application settings are missing"
  );
}

async function audit(
  tx: Db,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string | null,
  summary: string,
  metadata: Record<string, unknown> = {}
) {
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

async function idempotent<T extends Record<string, unknown>>(
  tx: Db,
  operation: string,
  key: string,
  work: () => Promise<T>
): Promise<T> {
  const existing = await tx.query.idempotencyKeys.findFirst({
    where: eq(idempotencyKeys.key, key)
  });
  if (existing) {
    assertState(existing.operation === operation, "idempotency_conflict", "This idempotency key belongs to another operation");
    return existing.response as T;
  }
  const response = await work();
  await tx.insert(idempotencyKeys).values({ key, operation, response });
  return response;
}

function rewardForTask(task: { basePoints: number; difficulty: keyof typeof DIFFICULTY_MULTIPLIER }): number {
  return task.basePoints * DIFFICULTY_MULTIPLIER[task.difficulty];
}

function visibleTaskCondition(now: Date) {
  return or(
    isNotNull(tasks.revealedAt),
    eq(tasks.revealMode, "immediate"),
    and(eq(tasks.revealMode, "at_time"), lte(tasks.visibleAt, now))
  );
}

async function materializeSeries(tx: Db, through: string): Promise<number> {
  const settings = await getSettings(tx);
  const seriesRows = await tx.query.taskSeries.findMany({
    where: and(eq(taskSeries.active, true), lte(taskSeries.startDate, through)),
    orderBy: [asc(taskSeries.startDate)]
  });
  let created = 0;

  for (const series of seriesRows) {
    const end = series.endDate && compareDates(series.endDate, through) < 0 ? series.endDate : through;
    let date = series.nextOccurrenceDate;
    let guard = 0;
    while (compareDates(date, end) <= 0) {
      guard += 1;
      if (guard > 3660) throw new AppError(422, "series_range_too_large", "A recurring task cannot materialize more than 10 years");
      const deadlineAt = localDateTime(date, series.dailyDeadlineTime, settings.timezone);
      const result = await tx
        .insert(tasks)
        .values({
          id: createId("task"),
          seriesId: series.id,
          occurrenceDate: date,
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
          revealedAt: new Date(),
          deadlineAt
        })
        .onConflictDoNothing()
        .returning({ id: tasks.id });
      created += result.length;
      date = addCalendarDays(date, 1);
    }
    await tx
      .update(taskSeries)
      .set({
        nextOccurrenceDate: date,
        active: series.endDate && compareDates(date, series.endDate) > 0 ? false : series.active,
        updatedAt: new Date()
      })
      .where(eq(taskSeries.id, series.id));
  }
  return created;
}

async function addLedger(
  tx: Db,
  entry: {
    type:
      | "task_reward"
      | "streak_bonus"
      | "task_penalty"
      | "redemption"
      | "manual_bonus"
      | "manual_penalty"
      | "correction";
    amount: number;
    key: string;
    reason: string;
    taskId?: string;
    redemptionId?: string;
    effectiveDate?: string;
  }
) {
  const existing = await tx.query.pointLedger.findFirst({
    where: eq(pointLedger.idempotencyKey, entry.key)
  });
  if (existing) return existing;
  const [created] = await tx
    .insert(pointLedger)
    .values({
      id: createId("points"),
      type: entry.type,
      amount: entry.amount,
      taskId: entry.taskId,
      redemptionId: entry.redemptionId,
      idempotencyKey: entry.key,
      reason: entry.reason,
      effectiveDate: entry.effectiveDate
    })
    .returning();
  return created;
}

async function currentBalance(tx: Db): Promise<number> {
  const [row] = await tx.select({ value: sql<number>`coalesce(sum(${pointLedger.amount}), 0)` }).from(pointLedger);
  return Number(row?.value ?? 0);
}

async function aiPenaltyUsedOnDate(tx: Db, date: string, timezone: string): Promise<number> {
  const from = localDateTime(date, "00:00", timezone);
  const to = localDateTime(addCalendarDays(date, 1), "00:00", timezone);
  const rows = await tx
    .select({ action: auditLogs.action, metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.actor, "AI"),
        inArray(auditLogs.action, ["points.penalty", "task.penalized"]),
        gte(auditLogs.createdAt, from),
        lt(auditLogs.createdAt, to)
      )
    );
  return rows.reduce((sum: number, row: any) => {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const value =
      row.action === "task.penalized"
        ? Number(metadata.actual ?? 0)
        : Math.max(0, -Number(metadata.amount ?? 0));
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}

async function applyPenalty(
  tx: Db,
  task: any,
  actor: Actor,
  reason: string,
  now = new Date()
): Promise<number> {
  const requested = Math.ceil(rewardForTask(task) * 0.5);
  const balance = await currentBalance(tx);
  const settings = await getSettings(tx);
  const penaltyDate = localDate(now, settings.timezone);
  let availableByBoundary = requested;
  if (actor === "AI") {
    assertState(
      !settings.punishmentsPaused,
      "punishments_paused",
      "Task failure penalties are paused by the user"
    );
    const usedToday = await aiPenaltyUsedOnDate(tx, penaltyDate, settings.timezone);
    availableByBoundary = Math.max(0, settings.dailyPenaltyLimit - usedToday);
  }
  const actual = Math.min(requested, Math.max(0, balance), availableByBoundary);
  if (actual > 0) {
    await addLedger(tx, {
      type: "task_penalty",
      amount: -actual,
      key: `task-penalty:${task.id}`,
      reason,
      taskId: task.id,
      effectiveDate: task.occurrenceDate ?? penaltyDate
    });
  }
  await audit(tx, actor, "task.penalized", "task", task.id, `Task penalty: -${actual}`, {
    requested,
    actual,
    reason,
    dailyLimit: actor === "AI" ? settings.dailyPenaltyLimit : null
  });
  return actual;
}

async function completeTask(tx: Db, task: any, completionDate: string, actor: Actor) {
  assertState(
    task.status === "pending" || task.status === "submitted",
    "task_not_completable",
    "Only pending or submitted tasks can be completed"
  );
  const now = new Date();
  await tx
    .update(tasks)
    .set({ status: "completed", completedAt: now, completionDate, updatedAt: now })
    .where(eq(tasks.id, task.id));
  const amount = rewardForTask(task);
  await addLedger(tx, {
    type: "task_reward",
    amount,
    key: `task-reward:${task.id}`,
    reason: `Completed: ${task.title}`,
    taskId: task.id,
    effectiveDate: completionDate
  });
  await audit(tx, actor, "task.completed", "task", task.id, `Completed task “${task.title}”`, {
    amount,
    completionDate
  });
}

async function recomputeActivityAndStats(tx: Db, now = new Date()) {
  const settings = await getSettings(tx);
  const completed = await tx
    .select({
      id: tasks.id,
      completionDate: tasks.completionDate,
      type: tasks.type,
      difficulty: tasks.difficulty
    })
    .from(tasks)
    .where(and(eq(tasks.status, "completed"), sql`${tasks.completionDate} is not null`))
    .orderBy(asc(tasks.completionDate), asc(tasks.completedAt));

  const counts = new Map<string, number>();
  const byType: Record<string, number> = {};
  const byDifficulty: Record<string, number> = {};
  for (const task of completed) {
    if (!task.completionDate) continue;
    counts.set(task.completionDate, (counts.get(task.completionDate) ?? 0) + 1);
    byType[task.type] = (byType[task.type] ?? 0) + 1;
    byDifficulty[task.difficulty] = (byDifficulty[task.difficulty] ?? 0) + 1;
  }

  await tx.delete(dailyActivity);
  const dates = [...counts.keys()].sort();
  let previous: string | undefined;
  let streak = 0;
  let longest = 0;
  for (const date of dates) {
    streak = previous && yesterday(date) === previous ? streak + 1 : 1;
    longest = Math.max(longest, streak);
    const desiredBonus = streakBonusForDay(streak);
    await tx.insert(dailyActivity).values({
      activityDate: date,
      completedCount: counts.get(date) ?? 0,
      streakLength: streak,
      streakBonus: desiredBonus,
      updatedAt: now
    });

    const bonusRows = await tx
      .select({ amount: pointLedger.amount })
      .from(pointLedger)
      .where(
        and(
          eq(pointLedger.effectiveDate, date),
          or(
            eq(pointLedger.type, "streak_bonus"),
            and(eq(pointLedger.type, "correction"), like(pointLedger.idempotencyKey, "streak-bonus:%"))
          )
        )
      );
    const existingBonus = bonusRows.reduce((sum: number, row: any) => sum + row.amount, 0);
    const delta = desiredBonus - existingBonus;
    if (delta !== 0) {
      await addLedger(tx, {
        type: existingBonus === 0 && delta > 0 ? "streak_bonus" : "correction",
        amount: delta,
        key: `streak-bonus:${date}:target-${desiredBonus}`,
        reason:
          existingBonus === 0
            ? `Day ${streak} streak bonus`
            : `Streak bonus recalculated after historical completion`,
        effectiveDate: date
      });
    }
    previous = date;
  }

  const ledgerRows = await tx.select({ type: pointLedger.type, amount: pointLedger.amount }).from(pointLedger);
  const balance = ledgerRows.reduce((sum: number, row: any) => sum + row.amount, 0);
  const totalEarned = ledgerRows.reduce((sum: number, row: any) => sum + Math.max(0, row.amount), 0);
  const totalSpent = -ledgerRows
    .filter((row: any) => row.type === "redemption")
    .reduce((sum: number, row: any) => sum + row.amount, 0);
  const totalPenalties = -ledgerRows
    .filter((row: any) => ["task_penalty", "manual_penalty"].includes(row.type))
    .reduce((sum: number, row: any) => sum + row.amount, 0);

  const today = localDate(now, settings.timezone);
  const lastDate = dates.at(-1);
  const currentStreak = lastDate && (lastDate === today || lastDate === yesterday(today)) ? streak : 0;

  await tx
    .update(statistics)
    .set({
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
    })
    .where(eq(statistics.id, 1));

  await evaluateAchievements(tx);
}

async function evaluateAchievements(tx: Db) {
  const stats = assertFound(await tx.query.statistics.findFirst({ where: eq(statistics.id, 1) }));
  const [{ value: redemptionCount }] = await tx
    .select({ value: sql<number>`count(*)` })
    .from(redemptions)
    .where(eq(redemptions.status, "fulfilled"));
  const definitions = await tx.query.achievements.findMany();
  const metrics: Record<string, number> = {
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
      await tx
        .insert(achievementUnlocks)
        .values({ id: createId("unlock"), achievementId: achievement.id })
        .onConflictDoNothing();
    }
  }
}

async function reconcileInTransaction(tx: Db, now = new Date()) {
  const settings = await getSettings(tx);
  const today = localDate(now, settings.timezone);
  const generated = await materializeSeries(tx, today);
  const overdue = await tx.query.tasks.findMany({
    where: and(eq(tasks.status, "pending"), lte(tasks.deadlineAt, now))
  });
  for (const task of overdue) {
    await tx
      .update(tasks)
      .set({ status: "expired", expiredAt: now, failureReason: "Deadline passed", updatedAt: now })
      .where(eq(tasks.id, task.id));
    await applyPenalty(tx, task, "system", "Task expired", now);
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

export async function reconcileSystem(now = new Date()) {
  return getDb().transaction((tx: Db) => reconcileInTransaction(tx, now));
}

export async function createTask(input: CreateTaskInput, actor: Actor = "AI") {
  return getDb().transaction(async (tx: Db) => {
    await reconcileInTransaction(tx);
    assertState(
      actor !== "AI" || !["image", "text_or_image"].includes(input.proof_requirement),
      "ai_image_only_proof_unsupported",
      "AI-created tasks must use none, text, or text_and_image proof so every reviewed submission includes readable text"
    );
    return idempotent(tx, "create_task", input.idempotency_key, async () => {
      const settings = await getSettings(tx);
      const today = localDate(new Date(), settings.timezone);
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
        await audit(tx, actor, "task_series.created", "task_series", seriesId, `Created daily series “${input.title}”`);
        const occurrence = await tx.query.tasks.findFirst({
          where: and(eq(tasks.seriesId, seriesId), eq(tasks.occurrenceDate, today))
        });
        return { kind: "series", series_id: seriesId, first_task: occurrence ?? null };
      }

      const now = new Date();
      assertState(
        !input.deadline || new Date(input.deadline) > now,
        "deadline_in_past",
        "A new task deadline must be in the future"
      );
      const id = createId("task");
      const visibleAt =
        input.reveal_mode === "at_time"
          ? new Date(input.visible_at!)
          : input.reveal_mode === "immediate"
            ? now
            : null;
      const [created] = await tx
        .insert(tasks)
        .values({
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
        })
        .returning();
      await audit(tx, actor, "task.created", "task", id, `Created task “${input.title}”`);
      return { kind: "task", task: created };
    });
  });
}

export async function revealNextVisitTasks(): Promise<number> {
  const db = getDb();
  const now = new Date();
  const rows = await db
    .update(tasks)
    .set({ revealedAt: now, updatedAt: now })
    .where(and(eq(tasks.revealMode, "next_visit"), isNull(tasks.revealedAt)))
    .returning({ id: tasks.id });
  return rows.length;
}

export async function queryTasks(input: TaskQueryInput, actor: Actor = "AI") {
  await reconcileSystem();
  const db = getDb();
  const conditions: any[] = [];
  if (input.task_id) conditions.push(eq(tasks.id, input.task_id));
  if (input.status) conditions.push(eq(tasks.status, input.status));
  if (input.type) conditions.push(eq(tasks.type, input.type));
  if (input.from) conditions.push(gte(sql`coalesce(${tasks.occurrenceDate}, ${tasks.completionDate})`, input.from));
  if (input.to) conditions.push(lte(sql`coalesce(${tasks.occurrenceDate}, ${tasks.completionDate})`, input.to));
  if (input.cursor) conditions.push(lt(tasks.createdAt, new Date(input.cursor)));
  if (actor === "user") conditions.push(visibleTaskCondition(new Date()));
  const rows = await db.query.tasks.findMany({
    where: conditions.length ? and(...conditions) : undefined,
    orderBy: [desc(tasks.createdAt)],
    limit: input.limit + 1,
    with: input.include_proof
      ? {
          submissions: {
            orderBy: [desc(taskSubmissions.attempt)],
            with: { assets: true }
          }
        }
      : undefined
  });
  const hasMore = rows.length > input.limit;
  const items = rows.slice(0, input.limit);
  return {
    items,
    next_cursor: hasMore ? items.at(-1)?.createdAt?.toISOString() : null
  };
}

export async function manageTask(input: ManageTaskInput, actor: Actor = "AI") {
  return getDb().transaction(async (tx: Db) => {
    await reconcileInTransaction(tx);
    return idempotent(tx, "manage_task", input.idempotency_key, async () => {
      const now = new Date();
      if (input.action === "pause_series" || input.action === "resume_series") {
        const series = assertFound(
          await tx.query.taskSeries.findFirst({ where: eq(taskSeries.id, input.series_id) }),
          "Task series not found"
        );
        const active = input.action === "resume_series";
        const settings = await getSettings(tx);
        await tx
          .update(taskSeries)
          .set({
            active,
            nextOccurrenceDate: active ? localDate(now, settings.timezone) : series.nextOccurrenceDate,
            updatedAt: now
          })
          .where(eq(taskSeries.id, series.id));
        await audit(tx, actor, `task_series.${active ? "resumed" : "paused"}`, "task_series", series.id, input.reason ?? "");
        return { series_id: series.id, active };
      }

      if (!("task_id" in input)) throw new AppError(400, "invalid_action", "Task action is invalid");
      const task = assertFound(await tx.query.tasks.findFirst({ where: eq(tasks.id, input.task_id) }), "Task not found");
      if (input.action === "edit") {
        assertState(task.status === "pending", "task_not_editable", "Only pending tasks can be edited");
        assertState(
          !input.deadline || new Date(input.deadline) > now,
          "deadline_in_past",
          "An edited task deadline must be in the future"
        );
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
          await tx
            .update(taskSeries)
            .set({
              title: patch.title,
              description: patch.description,
              difficulty: patch.difficulty,
              basePoints: patch.basePoints,
              ...(input.deadline
                ? { dailyDeadlineTime: timeInZone(new Date(input.deadline), (await getSettings(tx)).timezone) }
                : {}),
              updatedAt: now
            })
            .where(eq(taskSeries.id, task.seriesId));
          await tx
            .update(tasks)
            .set(futurePatch)
            .where(
              and(
                eq(tasks.seriesId, task.seriesId),
                gte(tasks.occurrenceDate, task.occurrenceDate!),
                eq(tasks.status, "pending")
              )
            );
          if (input.deadline) {
            const settings = await getSettings(tx);
            const deadlineTime = timeInZone(new Date(input.deadline), settings.timezone);
            const futureTasks = await tx.query.tasks.findMany({
              where: and(
                eq(tasks.seriesId, task.seriesId),
                gte(tasks.occurrenceDate, task.occurrenceDate!),
                eq(tasks.status, "pending")
              )
            });
            for (const futureTask of futureTasks) {
              if (!futureTask.occurrenceDate) continue;
              await tx
                .update(tasks)
                .set({
                  deadlineAt: localDateTime(futureTask.occurrenceDate, deadlineTime, settings.timezone),
                  updatedAt: now
                })
                .where(eq(tasks.id, futureTask.id));
            }
          }
        }
        await audit(tx, actor, "task.edited", "task", task.id, `Edited task “${task.title}”`, { scope: input.scope });
        return { task_id: task.id, status: task.status, updated: true };
      }

      if (input.action === "cancel" || input.action === "fail") {
        assertState(
          task.status === "pending" || task.status === "submitted",
          "task_final",
          "This task already has a final status"
        );
        const status = input.action === "fail" ? "failed" : "cancelled";
        await tx
          .update(tasks)
          .set({ status, failureReason: input.reason, updatedAt: now })
          .where(eq(tasks.id, task.id));
        if (task.status === "submitted") {
          await tx
            .update(taskSubmissions)
            .set({ status: "rejected", reviewedAt: now, reviewReason: input.reason })
            .where(and(eq(taskSubmissions.taskId, task.id), eq(taskSubmissions.status, "pending")));
        }
        let penalty = 0;
        if (input.action === "fail") penalty = await applyPenalty(tx, task, actor, input.reason, now);
        if (input.scope === "this_and_future" && task.seriesId) {
          await tx.update(taskSeries).set({ active: false, updatedAt: now }).where(eq(taskSeries.id, task.seriesId));
          await tx
            .update(tasks)
            .set({ status: "cancelled", failureReason: input.reason, updatedAt: now })
            .where(and(eq(tasks.seriesId, task.seriesId), gte(tasks.occurrenceDate, task.occurrenceDate!), eq(tasks.status, "pending")));
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
        await tx
          .update(taskSubmissions)
          .set({ status: "approved", reviewedAt: now, reviewReason: input.reason })
          .where(eq(taskSubmissions.id, submission.id));
        await completeTask(tx, task, completionDate, actor);
        await recomputeActivityAndStats(tx);
        return { task_id: task.id, status: "completed", completion_date: completionDate };
      }
      await tx
        .update(taskSubmissions)
        .set({ status: "rejected", reviewedAt: now, reviewReason: input.reason })
        .where(eq(taskSubmissions.id, submission.id));
      await tx
        .update(tasks)
        .set({
          status: "pending",
          submittedAt: null,
          deadlineAt: task.deadlineAt && task.deadlineAt <= now ? null : task.deadlineAt,
          updatedAt: now
        })
        .where(eq(tasks.id, task.id));
      await audit(tx, actor, "submission.rejected", "task", task.id, input.reason ?? "Submission rejected");
      return { task_id: task.id, status: "pending", rejected: true };
    });
  });
}

export async function submitTask(
  taskId: string,
  proofText: string,
  storedProofs: StoredProof[],
  actor: Actor = "user"
) {
  return getDb().transaction(async (tx: Db) => {
    await reconcileInTransaction(tx);
    const task = assertFound(await tx.query.tasks.findFirst({ where: eq(tasks.id, taskId) }), "Task not found");
    assertState(task.status === "pending", "task_not_pending", "Only a pending task can be submitted");
    const hasText = proofText.trim().length > 0;
    const hasImage = storedProofs.length > 0;
    const validProof =
      task.proofRequirement === "none" ||
      (task.proofRequirement === "text" && hasText) ||
      (task.proofRequirement === "image" && hasImage) ||
      (task.proofRequirement === "text_or_image" && (hasText || hasImage)) ||
      (task.proofRequirement === "text_and_image" && hasText && hasImage);
    assertState(validProof, "proof_required", `This task requires proof: ${task.proofRequirement}`);

    const [{ value: attempts }] = await tx
      .select({ value: sql<number>`count(*)` })
      .from(taskSubmissions)
      .where(eq(taskSubmissions.taskId, task.id));
    const submissionId = createId("submission");
    const now = new Date();
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
    await audit(tx, actor, "submission.created", "task", task.id, `Submitted proof for “${task.title}”`);
    return { task_id: task.id, submission_id: submissionId, status: "submitted" };
  });
}

export async function getOverview() {
  await reconcileSystem();
  const db = getDb();
  const settings = await getSettings(db);
  const stats = assertFound(await db.query.statistics.findFirst({ where: eq(statistics.id, 1) }));
  const today = localDate(new Date(), settings.timezone);
  const [counts] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${tasks.status} = 'pending' and (${visibleTaskCondition(new Date())}))`,
      submitted: sql<number>`count(*) filter (where ${tasks.status} = 'submitted')`,
      completedToday: sql<number>`count(*) filter (where ${tasks.completionDate} = ${today})`
    })
    .from(tasks);
  const [{ value: pendingRedemptions }] = await db
    .select({ value: sql<number>`count(*)` })
    .from(redemptions)
    .where(eq(redemptions.status, "pending"));
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

export async function queryHistory(input: {
  kind?: "all" | "tasks" | "points" | "redemptions" | "audit";
  limit?: number;
}) {
  await reconcileSystem();
  const db = getDb();
  const settings = await getSettings(db);
  const limit = Math.min(input.limit ?? 30, 100);
  const kind = input.kind ?? "all";
  const result: Record<string, unknown> = {};
  if (kind === "all" || kind === "tasks") {
    result.tasks = await db.query.tasks.findMany({
      where: inArray(tasks.status, ["completed", "failed", "expired", "cancelled"]),
      orderBy: [desc(tasks.updatedAt)],
      limit
    });
  }
  if (kind === "all" || kind === "points") {
    const rows = await db.query.pointLedger.findMany({ orderBy: [desc(pointLedger.createdAt)], limit });
    result.points = rows.map((row: any) => ({
      ...row,
      reason: presentLedgerReason(row.reason, settings.aiLabel)
    }));
  }
  if (kind === "all" || kind === "redemptions") {
    const rows = await db.query.redemptions.findMany({
      orderBy: [desc(redemptions.redeemedAt)],
      limit,
      with: { rewardItem: true }
    });
    result.redemptions = rows.map((row: any) => presentRedemption(row, settings.aiLabel));
  }
  if (kind === "all" || kind === "audit") {
    result.audit = await db.query.auditLogs.findMany({ orderBy: [desc(auditLogs.createdAt)], limit });
  }
  return result;
}

export async function manageRewards(input: RewardManageInput, actor: Actor = "AI") {
  const db = getDb();
  if (input.action === "list") {
    const settings = await getSettings(db);
    const rows = await db.query.rewardItems.findMany({
      where: input.include_archived ? undefined : eq(rewardItems.active, true),
      orderBy: [asc(rewardItems.sortOrder), asc(rewardItems.createdAt)]
    });
    return rows.map((row: any) => presentRewardItem(row, settings.aiLabel));
  }
  if (input.action === "list_redemptions") {
    const settings = await getSettings(db);
    const rows = await db.query.redemptions.findMany({
      where: input.status ? eq(redemptions.status, input.status) : undefined,
      orderBy: [desc(redemptions.redeemedAt)],
      with: { rewardItem: true }
    });
    return rows.map((row: any) => presentRedemption(row, settings.aiLabel));
  }

  return db.transaction(async (tx: Db) =>
    idempotent(tx, "manage_rewards", input.idempotency_key, async () => {
      if (input.action === "create") {
        const id = createId("reward");
        const [reward] = await tx
          .insert(rewardItems)
          .values({ id, name: input.name, description: input.description, cost: input.cost })
          .returning();
        await audit(tx, actor, "reward.created", "reward", id, `Created reward “${input.name}”`);
        return { reward };
      }
      if (input.action === "update") {
        const reward = assertFound(
          await tx.query.rewardItems.findFirst({ where: eq(rewardItems.id, input.reward_id) }),
          "Reward not found"
        );
        const [updated] = await tx
          .update(rewardItems)
          .set({
            name: input.name ?? reward.name,
            description: input.description ?? reward.description,
            cost: input.cost ?? reward.cost,
            updatedAt: new Date()
          })
          .where(eq(rewardItems.id, reward.id))
          .returning();
        await audit(tx, actor, "reward.updated", "reward", reward.id, `Updated reward “${reward.name}”`);
        return { reward: updated };
      }
      if (input.action === "archive" || input.action === "restore") {
        const reward = assertFound(
          await tx.query.rewardItems.findFirst({ where: eq(rewardItems.id, input.reward_id) }),
          "Reward not found"
        );
        const active = input.action === "restore";
        await tx.update(rewardItems).set({ active, updatedAt: new Date() }).where(eq(rewardItems.id, reward.id));
        await audit(
          tx,
          actor,
          active ? "reward.restored" : "reward.archived",
          "reward",
          reward.id,
          `${active ? "Restored" : "Archived"} reward “${reward.name}”`
        );
        return { reward_id: reward.id, active };
      }
      const redemption = assertFound(
        await tx.query.redemptions.findFirst({ where: eq(redemptions.id, input.redemption_id) }),
        "Redemption not found"
      );
      assertState(redemption.status === "pending", "redemption_final", "Redemption is already finalized");
      await tx
        .update(redemptions)
        .set({ status: "fulfilled", fulfilledAt: new Date(), fulfillmentNote: input.note })
        .where(eq(redemptions.id, redemption.id));
      await audit(tx, actor, "redemption.fulfilled", "redemption", redemption.id, input.note ?? "Reward fulfilled");
      await recomputeActivityAndStats(tx);
      return { redemption_id: redemption.id, status: "fulfilled" };
    })
  );
}

export async function redeemReward(rewardId: string, idempotencyKey: string) {
  return getDb().transaction(async (tx: Db) =>
    idempotent(tx, "redeem_reward", idempotencyKey, async () => {
      const settings = await getSettings(tx);
      const reward = assertFound(
        await tx.query.rewardItems.findFirst({ where: and(eq(rewardItems.id, rewardId), eq(rewardItems.active, true)) }),
        "Reward not found"
      );
      const presentedReward = presentRewardItem(reward, settings.aiLabel);
      const balance = await currentBalance(tx);
      assertState(balance >= reward.cost, "insufficient_points", "Not enough points for this reward");
      const id = createId("redemption");
      const [redemption] = await tx
        .insert(redemptions)
        .values({
          id,
          rewardItemId: reward.id,
          itemNameSnapshot: presentedReward.name,
          costSnapshot: reward.cost,
          idempotencyKey
        })
        .returning();
      await addLedger(tx, {
        type: "redemption",
        amount: -reward.cost,
        key: `redemption:${id}`,
        reason: `Redeemed: ${presentedReward.name}`,
        redemptionId: id
      });
      await audit(tx, "user", "reward.redeemed", "redemption", id, `Redeemed “${presentedReward.name}”`, { cost: reward.cost });
      await recomputeActivityAndStats(tx);
      return { redemption, balance: balance - reward.cost };
    })
  );
}

export async function adjustPoints(input: AdjustPointsInput, actor: Actor = "AI") {
  return getDb().transaction(async (tx: Db) =>
    idempotent(tx, "adjust_points", input.idempotency_key, async () => {
      const settings = await getSettings(tx);
      const now = new Date();
      const today = localDate(now, settings.timezone);
      const balanceBefore = await currentBalance(tx);
      let amount = input.amount;
      let type: "manual_bonus" | "manual_penalty" | "correction" = "manual_bonus";
      if (input.kind === "penalty") {
        assertState(!settings.punishmentsPaused, "punishments_paused", "Point penalties are paused by the user");
        const usedToday = await aiPenaltyUsedOnDate(tx, today, settings.timezone);
        const remaining = Math.max(0, settings.dailyPenaltyLimit - usedToday);
        assertState(remaining > 0, "daily_penalty_limit", "The user's daily penalty limit has been reached");
        amount = -Math.min(input.amount, remaining, Math.max(0, balanceBefore));
        type = "manual_penalty";
      } else if (input.kind === "correction") {
        assertState(
          balanceBefore + input.amount >= 0,
          "insufficient_points",
          "A correction cannot reduce the point balance below zero"
        );
        type = "correction";
      }
      if (amount === 0) {
        await audit(tx, actor, `points.${input.kind}`, "point_ledger", null, input.reason, {
          requestedAmount: input.amount,
          amount: 0
        });
        return { entry: null, balance: balanceBefore, applied_amount: 0 };
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
      return { entry, balance: await currentBalance(tx), applied_amount: amount };
    })
  );
}

export async function listAchievements() {
  await reconcileSystem();
  const db = getDb();
  return db.query.achievements.findMany({
    orderBy: [asc(achievements.sortOrder)],
    with: { unlocks: true }
  });
}

export async function getPublicSettings() {
  const settings = await getSettings(getDb());
  return {
    initialized: settings.initialized,
    setup_protected: config.SETUP_PROTECTED,
    timezone: settings.timezone,
    user_label: settings.userLabel,
    ai_label: settings.aiLabel
  };
}

export async function getUserSettings() {
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

export async function updateUserSettings(input: z.infer<typeof settingsSchema>) {
  return getDb().transaction(async (tx: Db) => {
    const previous = await getSettings(tx);
    const boundaryChanged =
      JSON.stringify(previous.allowedContent) !== JSON.stringify(input.allowed_content) ||
      JSON.stringify(previous.prohibitedContent) !== JSON.stringify(input.prohibited_content) ||
      previous.punishmentIntensity !== input.punishment_intensity ||
      previous.dailyPenaltyLimit !== input.daily_penalty_limit ||
      previous.punishmentsPaused !== input.punishments_paused ||
      previous.boundaryNotes !== input.boundary_notes;
    await tx
      .update(appSettings)
      .set({
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
        updatedAt: new Date()
      })
      .where(eq(appSettings.id, 1));
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
