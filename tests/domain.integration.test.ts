import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeDatabase, getDb, shutdownDatabase } from "../src/server/db/client";
import { seedDatabase } from "../src/server/db/seed";
import { appSettings, pointLedger, rewardItems, tasks, userAccount } from "../src/server/db/schema";
import { addCalendarDays, localDate } from "../src/server/lib/dates";
import { createId } from "../src/server/lib/ids";
import { setupApplication } from "../src/server/services/auth";
import {
  createTask,
  adjustPoints,
  getOverview,
  listAchievements,
  manageRewards,
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
    const databasePath = path.resolve(".data/test.sqlite");
    await Promise.all(
      ["", "-shm", "-wal"].map((suffix) =>
        fs.rm(`${databasePath}${suffix}`, { force: true })
      )
    );
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

  it("presents the two universal presets with the chosen label and retires old defaults", async () => {
    await getDb().update(appSettings).set({ aiLabel: "星沉" }).where(eq(appSettings.id, 1));
    await getDb()
      .update(rewardItems)
      .set({ description: "给 AI 一个主题，由它专门为你写。" })
      .where(eq(rewardItems.id, "reward_writing"));
    await seedDatabase();
    const rewards = await manageRewards({ action: "list", include_archived: false }) as any[];
    expect(rewards.map((reward: any) => reward.id)).toEqual(["reward_writing", "reward_listen"]);
    expect(rewards.find((reward: any) => reward.id === "reward_writing")?.name).toBe("指定 星沉 写东西");
    expect(rewards.find((reward: any) => reward.id === "reward_writing")?.description).toBe("给 星沉 一个主题，由 ta 专门为你写。");
    expect(rewards.find((reward: any) => reward.id === "reward_listen")?.name).toBe("“星沉 听你的”券");
  });

  it("deducts points atomically, keeps redemption pending until fulfillment, and does not spend twice on retry", async () => {
    await adjustPoints({
      kind: "bonus",
      amount: 10,
      reason: "Integration redemption balance",
      idempotency_key: "integration-redeem-balance"
    });
    const first = await redeemReward("reward_writing", "integration-redeem-writing");
    const retry = await redeemReward("reward_writing", "integration-redeem-writing");
    expect(retry.redemption.id).toBe(first.redemption.id);
    expect(retry.balance).toBe(first.balance);
    expect(first.redemption.status).toBe("pending");
    expect(first.redemption.itemNameSnapshot).toBe("指定 星沉 写东西");
    expect((await getOverview()).statistics.balance).toBe(5);
    await manageRewards({
      action: "fulfill_redemption",
      redemption_id: first.redemption.id,
      note: "Delivered in integration test",
      idempotency_key: "integration-fulfill-writing"
    });
    const rows = await manageRewards({ action: "list_redemptions", status: "fulfilled" }) as any[];
    expect(rows.find((row: any) => row.id === first.redemption.id)?.status).toBe("fulfilled");
  });

  it("lets the AI create, edit, and archive a custom reward through one MCP tool", async () => {
    const created = await manageRewards({
      action: "create",
      name: "一起看一部电影",
      description: "今晚共同挑选一部电影。",
      cost: 12,
      idempotency_key: "integration-create-custom-reward"
    });
    const rewardId = (created as any).reward.id;
    const updated = await manageRewards({
      action: "update",
      reward_id: rewardId,
      cost: 18,
      idempotency_key: "integration-update-custom-reward"
    });
    expect((updated as any).reward.cost).toBe(18);
    const visible = await manageRewards({ action: "list", include_archived: false }) as any[];
    expect(visible.find((reward: any) => reward.id === rewardId)).toMatchObject({
      name: "一起看一部电影",
      description: "今晚共同挑选一部电影。",
      cost: 18,
      active: true
    });
    await manageRewards({
      action: "archive",
      reward_id: rewardId,
      idempotency_key: "integration-archive-custom-reward"
    });
    const active = await manageRewards({ action: "list", include_archived: false }) as any[];
    expect(active.some((reward: any) => reward.id === rewardId)).toBe(false);
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

  it("lets the first visitor claim an uninitialized instance exactly once", async () => {
    const response = { cookie: () => undefined } as any;
    const input = {
      setup_token: "",
      password: "a-safe-local-password",
      timezone,
      user_label: "User",
      ai_label: "AI"
    };

    const result = await setupApplication(input, response);
    expect(result.ai_token).toMatch(/^phosphene_ai_/);
    await expect(setupApplication(input, response)).rejects.toMatchObject({
      status: 409,
      code: "already_initialized"
    });
    expect(await getDb().query.userAccount.findMany()).toHaveLength(1);
    expect((await getDb().query.appSettings.findFirst({ where: eq(appSettings.id, 1) }))?.initialized).toBe(true);
    expect((await getDb().query.userAccount.findFirst({ where: eq(userAccount.id, 1) }))?.passwordHash).not.toBe(
      input.password
    );
  });
});
