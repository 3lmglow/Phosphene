import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { config } from "../src/server/config";
import { getDb, initializeDatabase, runTransaction, shutdownDatabase } from "../src/server/db/client";
import { seedDatabase } from "../src/server/db/seed";
import { appSettings } from "../src/server/db/schema";
import { createTask, getOverview, queryTasks, reconcileSystem } from "../src/server/services/domain";
import { claimWebhookDelivery, updateWebhookSettings } from "../src/server/services/events";

const challenge = (key: string) => ({
  title: `Concurrent ${key}`,
  description: "",
  type: "challenge" as const,
  difficulty: "easy" as const,
  base_points: 1,
  verification_mode: "self" as const,
  proof_requirement: "none" as const,
  recurrence: "once" as const,
  daily_deadline_time: "23:59",
  reveal_mode: "immediate" as const,
  idempotency_key: `concurrency-${key}`
});

describe.sequential("database concurrency", () => {
  beforeAll(async () => {
    const directory = path.resolve(".data/concurrency-integration");
    await fs.mkdir(directory, { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.rm(path.join(directory, `test.sqlite${suffix}`), { force: true });
    }
    config.SQLITE_PATH = path.join(directory, "test.sqlite");
    await initializeDatabase();
    await seedDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await shutdownDatabase();
  });

  it("queues write transactions that would otherwise overlap", async () => {
    const order: string[] = [];
    const write = (label: string) =>
      runTransaction(async (tx) => {
        order.push(`${label}:start`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await tx.update(appSettings).set({ aiLabel: label }).where(eq(appSettings.id, 1));
        order.push(`${label}:end`);
        return label;
      });
    expect(await Promise.all([write("first"), write("second")])).toEqual(["first", "second"]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect((await getDb().query.appSettings.findFirst())?.aiLabel).toBe("second");
  });

  it("keeps the queue usable after a failed transaction", async () => {
    await expect(runTransaction(async () => {
      throw new Error("expected failure");
    })).rejects.toThrow("expected failure");
    expect(await runTransaction(async () => "recovered")).toBe("recovered");
  });

  it("rejects a nested transaction instead of waiting on itself forever", async () => {
    await expect(
      runTransaction(() => runTransaction(async () => "inner"))
    ).rejects.toThrow("runTransaction cannot be nested");
  });

  it("completes overlapping reads and writes from the user, the AI and reconciliation", async () => {
    const results = await Promise.allSettled([
      createTask(challenge("a")),
      createTask(challenge("b")),
      reconcileSystem(),
      getOverview(),
      queryTasks({ status: "pending", include_proof: false, limit: 10 }, "user"),
      createTask(challenge("c"))
    ]);
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    const pending = await queryTasks({ status: "pending", include_proof: false, limit: 10 }, "user");
    expect(pending.items.map((task: any) => task.title).sort()).toEqual([
      "Concurrent a",
      "Concurrent b",
      "Concurrent c"
    ]);
  });

  it("does not open a transaction while the Webhook is disabled", async () => {
    const transaction = vi.spyOn(getDb(), "transaction");
    expect(await claimWebhookDelivery()).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not open a transaction when the Webhook has nothing due", async () => {
    await updateWebhookSettings({
      enabled: true,
      url: "https://example.com/phosphene/events",
      event_types: ["task.completed"]
    });
    const transaction = vi.spyOn(getDb(), "transaction");
    expect(await claimWebhookDelivery()).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
  });
});
