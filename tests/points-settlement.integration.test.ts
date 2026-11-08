import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { getDb, initializeDatabase, shutdownDatabase } from "../src/server/db/client";
import { seedDatabase } from "../src/server/db/seed";
import { auditLogs, tasks } from "../src/server/db/schema";
import {
  adjustPoints,
  createTask,
  getOverview,
  manageRewards,
  redeemReward
} from "../src/server/services/domain";

const HOUR = 3_600_000;

async function balance(): Promise<number> {
  return (await getOverview()).statistics.balance;
}

async function setBalance(target: number, key: string): Promise<void> {
  const current = await balance();
  if (current === target) return;
  await adjustPoints({
    kind: "correction",
    amount: target - current,
    reason: "Set up a known balance",
    idempotency_key: `points-settlement-balance-${key}`
  });
  expect(await balance()).toBe(target);
}

// A 10-point task whose deadline has just passed, so the next settlement owes a 5-point penalty.
async function createJustOverdueTask(key: string): Promise<string> {
  const created = await createTask({
    title: `Just overdue ${key}`,
    description: "",
    type: "challenge",
    difficulty: "easy",
    base_points: 10,
    verification_mode: "self",
    proof_requirement: "none",
    recurrence: "once",
    daily_deadline_time: "23:59",
    deadline: new Date(Date.now() + HOUR).toISOString(),
    reveal_mode: "immediate",
    idempotency_key: `points-settlement-task-${key}`
  });
  if (created.kind !== "task") throw new Error("Expected a one-time task");
  // Move the deadline without going through anything that reconciles.
  await getDb()
    .update(tasks)
    .set({ deadlineAt: new Date(Date.now() - 60_000) })
    .where(eq(tasks.id, created.task.id));
  return created.task.id;
}

async function createReward(key: string, cost: number): Promise<string> {
  const created = (await manageRewards({
    action: "create",
    name: `Reward ${key}`,
    description: "",
    cost,
    idempotency_key: `points-settlement-reward-${key}`
  })) as { reward: { id: string } };
  return created.reward.id;
}

async function penaltyTaken(taskId: string): Promise<unknown> {
  const row = await getDb().query.auditLogs.findFirst({
    where: and(eq(auditLogs.action, "task.penalized"), eq(auditLogs.entityId, taskId))
  });
  return (row?.metadata as Record<string, unknown> | undefined)?.actual;
}

describe.sequential("overdue penalties settle before balance-dependent writes", () => {
  beforeAll(async () => {
    const directory = path.resolve(".data/points-settlement-integration");
    await fs.mkdir(directory, { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.rm(path.join(directory, `test.sqlite${suffix}`), { force: true });
    }
    config.SQLITE_PATH = path.join(directory, "test.sqlite");
    await initializeDatabase();
    await seedDatabase();
  });

  afterAll(async () => {
    await shutdownDatabase();
  });

  it("refuses a redemption the balance no longer covers once the overdue penalty is taken", async () => {
    const rewardId = await createReward("exact", 10);
    await setBalance(10, "exact");
    const taskId = await createJustOverdueTask("exact");

    await expect(redeemReward(rewardId, "points-settlement-redeem-exact")).rejects.toMatchObject({
      code: "insufficient_points"
    });

    expect(await balance()).toBe(5);
    expect(await getDb().query.tasks.findFirst({ where: eq(tasks.id, taskId) })).toMatchObject({
      status: "expired"
    });
    expect(await penaltyTaken(taskId)).toBe(5);
  });

  it("takes the overdue penalty before the redemption cost", async () => {
    const rewardId = await createReward("covered", 10);
    await setBalance(20, "covered");
    const taskId = await createJustOverdueTask("covered");

    const redeemed = await redeemReward(rewardId, "points-settlement-redeem-covered");
    expect(redeemed.balance).toBe(5);
    expect(await penaltyTaken(taskId)).toBe(5);
    expect(await balance()).toBe(5);
  });

  it("settles the overdue penalty before an AI penalty is capped by the balance", async () => {
    await setBalance(10, "ai-penalty");
    const taskId = await createJustOverdueTask("ai-penalty");

    const adjusted = await adjustPoints({
      kind: "penalty",
      amount: 10,
      reason: "AI penalty after a missed task",
      idempotency_key: "points-settlement-ai-penalty"
    });
    expect(adjusted.applied_amount).toBe(-5);
    expect(await penaltyTaken(taskId)).toBe(5);
    expect(await balance()).toBe(0);
  });
});
