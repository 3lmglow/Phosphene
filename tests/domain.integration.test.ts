import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeDatabase, getDb, shutdownDatabase } from "../src/server/db/client";
import { seedDatabase } from "../src/server/db/seed";
import { pointLedger, tasks } from "../src/server/db/schema";
import { addCalendarDays, localDate } from "../src/server/lib/dates";
import { createId } from "../src/server/lib/ids";
import {
  createTask,
  adjustPoints,
  getOverview,
  listAchievements,
  manageTask,
  queryTasks,
  reconcileSystem,
  redeemReward,
  submitTask
} from "../src/server/services/domain";
import { exportBackup, restoreBackup } from "../src/server/services/backup";

describe.sequential("Phosphene domain integration", () => {
  const timezone = "Asia/Shanghai";
  const today = localDate(new Date(), timezone);
  let dailyTaskId = "";

  beforeAll(async () => {
    await initializeDatabase();
    await seedDatabase();
  });

  afterAll(async () => {
    await shutdownDatabase();
  });

  it("materializes a recurring daily exactly once under retries", async () => {
    const input = {
      title: "Integration daily",
      description: "Generated once",
      type: "daily" as const,
      difficulty: "easy" as const,
      base_points: 4,
      verification_mode: "self" as const,
      proof_requirement: "none" as const,
      recurrence: "daily" as const,
      start_date: today,
      daily_deadline_time: "23:59",
      reveal_mode: "immediate" as const,
      idempotency_key: "integration-create-daily"
    };
    const first = await createTask(input);
    const retry = await createTask(input);
    expect(retry.kind).toBe(first.kind);
    expect(retry.series_id).toBe(first.series_id);
    const result = await queryTasks({ status: "pending", type: "daily", include_proof: false, limit: 100 });
    const matches = result.items.filter((task: any) => task.title === input.title);
    expect(matches).toHaveLength(1);
    dailyTaskId = matches[0].id;
  });

  it("settles a self-confirmed task and unlocks the first achievement", async () => {
    await submitTask(dailyTaskId, "", []);
    const overview = await getOverview();
    expect(overview.statistics.balance).toBe(4);
    expect(overview.statistics.currentStreak).toBe(1);
    expect(overview.statistics.totalCompletedTasks).toBe(1);
    const achievementRows = await listAchievements();
    expect(achievementRows.find((item: any) => item.id === "first_task")?.unlocks).toHaveLength(1);
  });

  it("backfills a delayed historical completion and recalculates the streak bonus", async () => {
    const previousDate = addCalendarDays(today, -1);
    const historicalId = createId("task");
    await getDb().insert(tasks).values({
      id: historicalId,
      title: "Delayed approval",
      description: "",
      type: "challenge",
      difficulty: "easy",
      basePoints: 5,
      status: "completed",
      verificationMode: "ai_review",
      proofRequirement: "text",
      deadlineAt: new Date(Date.now() + 86_400_000),
      completedAt: new Date(),
      completionDate: previousDate
    });
    await getDb().insert(pointLedger).values({
      id: createId("points"),
      type: "task_reward",
      amount: 5,
      taskId: historicalId,
      idempotencyKey: `task-reward:${historicalId}`,
      reason: "Historical reward",
      effectiveDate: previousDate
    });
    await reconcileSystem();
    const overview = await getOverview();
    expect(overview.statistics.currentStreak).toBe(2);
    expect(overview.statistics.longestStreak).toBe(2);
    expect(overview.statistics.balance).toBe(10);
    const bonuses = await getDb().query.pointLedger.findMany({
      where: eq(pointLedger.type, "streak_bonus")
    });
    expect(bonuses.some((entry: any) => entry.effectiveDate === today && entry.amount === 1)).toBe(true);
  });

  it("redeems atomically and does not spend twice on retry", async () => {
    const first = await redeemReward("reward_song", "integration-redeem-song");
    const retry = await redeemReward("reward_song", "integration-redeem-song");
    expect(retry.redemption.id).toBe(first.redemption.id);
    expect(retry.balance).toBe(first.balance);
    expect((await getOverview()).statistics.balance).toBe(5);
  });

  it("caps a failed-task penalty at the available balance and is idempotent", async () => {
    const created = await createTask({
      title: "Penalty task",
      description: "",
      type: "daily",
      difficulty: "hard",
      base_points: 20,
      verification_mode: "self",
      proof_requirement: "none",
      recurrence: "once",
      daily_deadline_time: "23:59",
      reveal_mode: "immediate",
      idempotency_key: "integration-penalty-task"
    });
    if (created.kind !== "task") throw new Error("Expected one-time task");
    const input = {
      action: "fail" as const,
      task_id: created.task.id,
      scope: "occurrence" as const,
      reason: "Integration failure",
      idempotency_key: "integration-fail-task"
    };
    const failed = await manageTask(input);
    const retry = await manageTask(input);
    expect(retry.task_id).toBe(failed.task_id);
    expect(retry.penalty).toBe(failed.penalty);
    expect(failed.penalty).toBe(5);
    expect((await getOverview()).statistics.balance).toBe(0);
  });

  it("round-trips a versioned application backup without replacing credentials", async () => {
    const archive = await exportBackup();
    await adjustPoints({
      kind: "bonus",
      amount: 99,
      reason: "Temporary post-backup mutation",
      idempotency_key: "integration-post-backup-bonus"
    });
    expect((await getOverview()).statistics.balance).toBe(99);
    await restoreBackup(archive);
    expect((await getOverview()).statistics.balance).toBe(0);
  });
});
