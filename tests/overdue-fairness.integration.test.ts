import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { getDb, initializeDatabase, shutdownDatabase } from "../src/server/db/client";
import { seedDatabase } from "../src/server/db/seed";
import { auditLogs, domainEvents, taskSeries, tasks } from "../src/server/db/schema";
import { addCalendarDays, localDate } from "../src/server/lib/dates";
import { createId } from "../src/server/lib/ids";
import {
  adjustPoints,
  createTask,
  getOverview,
  manageTask,
  reconcileSystem,
  revealNextVisitTasks
} from "../src/server/services/domain";
import type { CreateTaskInput } from "../src/shared/schemas";

const HOUR = 3_600_000;

// "00:00" has always passed by the time any request runs on the same local day.
const PASSED_DEADLINE_TIME = "00:00";

const dailySeries = (key: string, extra: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  title: `Overdue fairness ${key}`,
  description: "",
  type: "daily" as const,
  difficulty: "easy" as const,
  base_points: 4,
  verification_mode: "self" as const,
  proof_requirement: "none" as const,
  recurrence: "daily" as const,
  daily_deadline_time: PASSED_DEADLINE_TIME,
  reveal_mode: "immediate" as const,
  idempotency_key: `overdue-fairness-${key}`,
  ...extra
});

const surprise = (key: string, extra: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  title: `Surprise ${key}`,
  description: "",
  type: "surprise" as const,
  difficulty: "easy" as const,
  base_points: 10,
  verification_mode: "self" as const,
  proof_requirement: "none" as const,
  recurrence: "once" as const,
  daily_deadline_time: "23:59",
  deadline: new Date(Date.now() + 24 * HOUR).toISOString(),
  reveal_mode: "next_visit" as const,
  idempotency_key: `overdue-surprise-${key}`,
  ...extra
});

async function createSurprise(key: string, extra: Partial<CreateTaskInput> = {}) {
  const created = await createTask(surprise(key, extra));
  if (created.kind !== "task") throw new Error("Expected a one-time surprise");
  return created.task;
}

async function balance() {
  return (await getOverview()).statistics.balance;
}

async function insertPausedSeries(key: string, values: Partial<typeof taskSeries.$inferInsert>) {
  const id = createId("series");
  await getDb().insert(taskSeries).values({
    id,
    title: `Paused ${key}`,
    description: "",
    difficulty: "easy",
    basePoints: 4,
    verificationMode: "self",
    proofRequirement: "none",
    recurrence: "daily",
    startDate: values.startDate!,
    nextOccurrenceDate: values.nextOccurrenceDate!,
    dailyDeadlineTime: PASSED_DEADLINE_TIME,
    active: false,
    pausedAt: new Date(Date.now() - 48 * HOUR),
    createdBy: "AI",
    ...values
  });
  return id;
}

async function expiredEventPayload(taskId: string) {
  const event = await getDb().query.domainEvents.findFirst({
    where: eq(domainEvents.dedupeKey, `task.expired:${taskId}`)
  });
  return event?.payload as Record<string, unknown> | undefined;
}

async function penaltyAudit(taskId: string) {
  const row = await getDb().query.auditLogs.findFirst({
    where: and(eq(auditLogs.action, "task.penalized"), eq(auditLogs.entityId, taskId))
  });
  return row?.metadata as Record<string, unknown> | undefined;
}

describe.sequential("fair system expiry", () => {
  let today = "";
  let tomorrow = "";

  beforeAll(async () => {
    const directory = path.resolve(".data/overdue-integration");
    await fs.mkdir(directory, { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.rm(path.join(directory, `test.sqlite${suffix}`), { force: true });
    }
    config.SQLITE_PATH = path.join(directory, "test.sqlite");
    await initializeDatabase();
    await seedDatabase();
    const settings = await getDb().query.appSettings.findFirst();
    today = localDate(new Date(), settings!.timezone);
    tomorrow = addCalendarDays(today, 1);
    await adjustPoints({
      kind: "bonus",
      amount: 100,
      reason: "Balance that would reveal an unfair deduction",
      idempotency_key: "overdue-fairness-balance"
    });
  });

  afterAll(async () => {
    await shutdownDatabase();
  });

  it("starts a new daily series tomorrow when today's deadline has already passed", async () => {
    const before = await balance();
    const created = await createTask(dailySeries("late-create", { start_date: today }));
    expect(created).toMatchObject({ kind: "series", first_task: null, first_occurrence_date: tomorrow });
    const seriesId = created.series_id as string;

    expect(await reconcileSystem()).toMatchObject({ generated: 0, expired: 0 });
    expect(await getDb().query.tasks.findMany({ where: eq(tasks.seriesId, seriesId) })).toEqual([]);
    expect(
      await getDb().query.taskSeries.findFirst({ where: eq(taskSeries.id, seriesId) })
    ).toMatchObject({ active: true, startDate: tomorrow, nextOccurrenceDate: tomorrow });
    expect(await balance()).toBe(before);
  });

  it("rejects a daily series whose only day has already passed its deadline", async () => {
    await expect(
      createTask(dailySeries("only-day-passed", { start_date: today, end_date: today }))
    ).rejects.toMatchObject({ code: "deadline_in_past" });
    expect(
      await getDb().query.taskSeries.findFirst({
        where: eq(taskSeries.title, "Overdue fairness only-day-passed")
      })
    ).toBeUndefined();
  });

  it("resumes a paused daily series from tomorrow once today's deadline has passed", async () => {
    const seriesId = await insertPausedSeries("late-resume", {
      startDate: addCalendarDays(today, -3),
      nextOccurrenceDate: addCalendarDays(today, -2)
    });
    const before = await balance();
    expect(
      await manageTask({
        action: "resume_series",
        series_id: seriesId,
        reason: "Resume in the evening",
        idempotency_key: "overdue-fairness-late-resume"
      })
    ).toMatchObject({ series_id: seriesId, active: true, affected_tasks: 0 });

    expect(await reconcileSystem()).toMatchObject({ generated: 0, expired: 0 });
    expect(await getDb().query.tasks.findMany({ where: eq(tasks.seriesId, seriesId) })).toEqual([]);
    expect(
      (await getDb().query.taskSeries.findFirst({ where: eq(taskSeries.id, seriesId) }))?.nextOccurrenceDate
    ).toBe(tomorrow);
    expect(await balance()).toBe(before);
  });

  it("refuses to resume a series on its last day after that day's deadline", async () => {
    const seriesId = await insertPausedSeries("last-day-resume", {
      startDate: addCalendarDays(today, -2),
      nextOccurrenceDate: addCalendarDays(today, -1),
      endDate: today
    });
    await expect(
      manageTask({
        action: "resume_series",
        series_id: seriesId,
        idempotency_key: "overdue-fairness-last-day-resume"
      })
    ).rejects.toMatchObject({ code: "series_ended" });
    expect(await getDb().query.taskSeries.findFirst({ where: eq(taskSeries.id, seriesId) })).toMatchObject({
      active: false,
      nextOccurrenceDate: addCalendarDays(today, -1)
    });
    expect(await getDb().query.tasks.findMany({ where: eq(tasks.seriesId, seriesId) })).toEqual([]);
  });

  it("does not deduct points for a surprise revealed only after its deadline", async () => {
    const task = await createSurprise("revealed-late");
    // Read the balance first: getOverview reconciles, which would expire the task early.
    const before = await balance();
    await getDb()
      .update(tasks)
      .set({ deadlineAt: new Date(Date.now() - 60_000) })
      .where(eq(tasks.id, task.id));
    // The user's first visit after the deadline reveals it before reconciliation runs.
    expect(await revealNextVisitTasks()).toBe(1);

    expect((await reconcileSystem()).expired).toBe(1);
    expect(await getDb().query.tasks.findFirst({ where: eq(tasks.id, task.id) })).toMatchObject({
      status: "expired",
      failureReason: "Deadline passed before the task was revealed"
    });
    expect(await expiredEventPayload(task.id)).toMatchObject({ status: "expired", penalty_points: 0 });
    expect(await penaltyAudit(task.id)).toMatchObject({ requested: 5, actual: 0 });
    expect(await balance()).toBe(before);
  });

  it("does not deduct points for surprises still hidden when their deadline passed", async () => {
    const neverVisited = await createSurprise("never-visited");
    const visibleAt = new Date(Date.now() + HOUR);
    const timedLate = await createSurprise("timed-after-deadline", {
      reveal_mode: "at_time",
      visible_at: visibleAt.toISOString(),
      deadline: new Date(Date.now() + 2 * HOUR).toISOString()
    });
    const before = await balance();
    for (const id of [neverVisited.id, timedLate.id]) {
      await getDb()
        .update(tasks)
        .set({ deadlineAt: new Date(Date.now() - 60_000) })
        .where(eq(tasks.id, id));
    }

    expect((await reconcileSystem()).expired).toBe(2);
    for (const id of [neverVisited.id, timedLate.id]) {
      expect((await getDb().query.tasks.findFirst({ where: eq(tasks.id, id) }))?.status).toBe("expired");
      expect(await expiredEventPayload(id)).toMatchObject({ penalty_points: 0 });
      expect(await penaltyAudit(id)).toMatchObject({ actual: 0 });
    }
    expect(await balance()).toBe(before);
  });

  it("still deducts points for surprises the user could see before their deadline", async () => {
    const timed = await createSurprise("timed-before-deadline", {
      reveal_mode: "at_time",
      visible_at: new Date(Date.now() + HOUR).toISOString(),
      deadline: new Date(Date.now() + 2 * HOUR).toISOString()
    });
    const visited = await createSurprise("visited-before-deadline");
    const before = await balance();
    await getDb()
      .update(tasks)
      .set({ visibleAt: new Date(Date.now() - 2 * HOUR), deadlineAt: new Date(Date.now() - 60_000) })
      .where(eq(tasks.id, timed.id));
    await getDb()
      .update(tasks)
      .set({ revealedAt: new Date(Date.now() - 2 * HOUR), deadlineAt: new Date(Date.now() - 60_000) })
      .where(eq(tasks.id, visited.id));

    expect((await reconcileSystem()).expired).toBe(2);
    for (const id of [timed.id, visited.id]) {
      expect(await getDb().query.tasks.findFirst({ where: eq(tasks.id, id) })).toMatchObject({
        status: "expired",
        failureReason: "Deadline passed"
      });
      expect(await expiredEventPayload(id)).toMatchObject({ penalty_points: 5 });
    }
    expect(await balance()).toBe(before - 10);
  });

  it("keeps a timed surprise's edited deadline after its reveal time", async () => {
    const originalDeadline = new Date(Date.now() + 3 * HOUR);
    const timed = await createSurprise("timed-edit", {
      reveal_mode: "at_time",
      visible_at: new Date(Date.now() + 2 * HOUR).toISOString(),
      deadline: originalDeadline.toISOString()
    });
    await expect(
      manageTask({
        action: "edit",
        task_id: timed.id,
        scope: "occurrence",
        deadline: new Date(Date.now() + HOUR).toISOString(),
        idempotency_key: "overdue-fairness-edit-before-reveal"
      })
    ).rejects.toMatchObject({ code: "invalid_reveal_window" });
    expect(
      (await getDb().query.tasks.findFirst({ where: eq(tasks.id, timed.id) }))?.deadlineAt?.valueOf()
    ).toBe(originalDeadline.valueOf());

    const laterDeadline = new Date(Date.now() + 4 * HOUR);
    await manageTask({
      action: "edit",
      task_id: timed.id,
      scope: "occurrence",
      deadline: laterDeadline.toISOString(),
      idempotency_key: "overdue-fairness-edit-after-reveal"
    });
    expect(
      (await getDb().query.tasks.findFirst({ where: eq(tasks.id, timed.id) }))?.deadlineAt?.valueOf()
    ).toBe(laterDeadline.valueOf());
  });
});
