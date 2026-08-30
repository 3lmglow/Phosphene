import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { finished } from "node:stream/promises";
import { ZipArchive, type ZipEntryData } from "archiver";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPromise } from "yauzl";
import { config } from "../src/server/config";
import { initializeDatabase, getDb, shutdownDatabase } from "../src/server/db/client";
import { seedDatabase } from "../src/server/db/seed";
import {
  appSettings,
  auditLogs,
  dailyActivity,
  domainEvents,
  pointLedger,
  proofAssets,
  rewardItems,
  statistics,
  taskSeries,
  tasks,
  userAccount,
  webhookConfig,
  webhookDeliveries
} from "../src/server/db/schema";
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
  queryHistory,
  queryTasks,
  reconcileSystem,
  redeemReward,
  submitTask,
  updateUserSettings
} from "../src/server/services/domain";
import {
  claimWebhookDelivery,
  createWebhookTestEvent,
  getWebhookSettings,
  markWebhookFailed,
  retryWebhookDelivery,
  rotateWebhookSecret,
  updateWebhookSettings,
  WEBHOOK_MAX_ATTEMPTS
} from "../src/server/services/events";
import {
  deliverWebhookClaim,
  signWebhookBody
} from "../src/server/services/webhook-worker";
import {
  beginApplicationRequest,
  exportBackupToFile,
  getActiveBackupOperation,
  restoreBackupFromFile
} from "../src/server/services/backup";
import {
  getObject,
  getObjectPath,
  initializeStorage,
  isValidProofObjectKey,
  saveProofImages
} from "../src/server/services/storage";

async function readBackupManifest(filePath: string): Promise<Record<string, any>> {
  const zip = await openPromise(filePath, {
    autoClose: true,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true
  });
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== "phosphene-backup.json") {
        throw new Error("Backup manifest is not the first entry");
      }
      const chunks: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(entry)) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    throw new Error("Backup manifest is missing");
  } finally {
    if (zip.isOpen) zip.close();
  }
}

async function writeLegacyBackup(
  filePath: string,
  manifest: Record<string, any>,
  assets: Array<{ objectKey: string; previewKey: string }>
): Promise<void> {
  const output = createWriteStream(filePath, { flags: "wx" });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.pipe(output);
  const archiveDone = finished(archive);
  const outputDone = finished(output);
  archive.once("warning", (error) => archive.emit("error", error));
  archive.append(JSON.stringify(manifest), { name: "phosphene-backup.json" });
  for (const asset of assets) {
    for (const key of [asset.objectKey, asset.previewKey]) {
      const entry: ZipEntryData = { name: `objects/${key}`, store: true };
      archive.file(getObjectPath(key), entry);
    }
  }
  await archive.finalize();
  await Promise.all([archiveDone, outputDone]);
}

describe.sequential("Phosphene domain integration", () => {
  const timezone = "Asia/Shanghai";
  const today = localDate(new Date(), timezone);
  let dailyTaskId = "";
  let legacyImageTaskId = "";

  beforeAll(async () => {
    const databasePath = path.resolve(".data/test.sqlite");
    await Promise.all(
      ["", "-shm", "-wal"].map((suffix) =>
        fs.rm(`${databasePath}${suffix}`, { force: true })
      )
    );
    await fs.rm(path.resolve(".data/test-uploads"), { recursive: true, force: true });
    await initializeDatabase();
    await initializeStorage();
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

  it("rejects reuse of an idempotency key with a different request payload", async () => {
    const input = {
      title: "Idempotency payload A",
      description: "The original request",
      type: "challenge" as const,
      difficulty: "easy" as const,
      base_points: 2,
      verification_mode: "self" as const,
      proof_requirement: "none" as const,
      recurrence: "once" as const,
      daily_deadline_time: "23:59",
      reveal_mode: "immediate" as const,
      idempotency_key: "integration-idempotency-payload"
    };
    await createTask(input);
    await expect(
      createTask({ ...input, title: "Idempotency payload B" })
    ).rejects.toMatchObject({ code: "idempotency_payload_conflict" });
  });

  it("pauses today's pending recurring occurrence immediately and restores it on a timely resume", async () => {
    const seriesId = createId("series");
    const taskId = createId("task");
    await getDb().insert(taskSeries).values({
      id: seriesId,
      title: "Immediate pause daily",
      description: "Should leave today's queue as soon as its series is paused",
      difficulty: "easy",
      basePoints: 3,
      verificationMode: "ai_review",
      proofRequirement: "text",
      recurrence: "daily",
      startDate: today,
      nextOccurrenceDate: addCalendarDays(today, 1),
      dailyDeadlineTime: "23:59",
      active: true,
      createdBy: "AI"
    });
    await getDb().insert(tasks).values({
      id: taskId,
      seriesId,
      occurrenceDate: today,
      title: "Immediate pause daily",
      description: "",
      type: "daily",
      difficulty: "easy",
      basePoints: 3,
      status: "pending",
      verificationMode: "ai_review",
      proofRequirement: "text",
      createdBy: "AI",
      source: "recurring",
      revealMode: "immediate",
      revealedAt: new Date(),
      deadlineAt: new Date(Date.now() + 86_400_000)
    });

    const paused = await manageTask({
      action: "pause_series",
      series_id: seriesId,
      reason: "Take a break now",
      idempotency_key: "integration-pause-series-now"
    });
    expect(paused).toMatchObject({ series_id: seriesId, active: false, affected_tasks: 1 });
    expect((await getDb().query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.status).toBe("cancelled");
    expect((await getDb().query.taskSeries.findFirst({ where: eq(taskSeries.id, seriesId) }))?.active).toBe(false);
    expect(
      (await queryTasks({ status: "pending", include_proof: false, limit: 100 })).items.some(
        (task: any) => task.id === taskId
      )
    ).toBe(false);

    const resumed = await manageTask({
      action: "resume_series",
      series_id: seriesId,
      reason: "Continue today",
      idempotency_key: "integration-resume-series-now"
    });
    expect(resumed).toMatchObject({ series_id: seriesId, active: true, affected_tasks: 1 });
    expect((await getDb().query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.status).toBe("pending");

    await submitTask(taskId, "Work already submitted for review", []);
    const pausedAfterSubmission = await manageTask({
      action: "pause_series",
      series_id: seriesId,
      reason: "Pause without discarding submitted work",
      idempotency_key: "integration-pause-submitted-series"
    });
    expect(pausedAfterSubmission).toMatchObject({ active: false, affected_tasks: 0 });
    expect((await getDb().query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.status).toBe("submitted");
  });

  it("repairs pending occurrences left behind by the pre-fix pause behavior", async () => {
    const pausedSeriesId = createId("series");
    const pausedTaskId = createId("task");
    const endedSeriesId = createId("series");
    const endedTaskId = createId("task");
    await getDb().insert(taskSeries).values([
      {
        id: pausedSeriesId,
        title: "Legacy paused daily",
        description: "",
        difficulty: "easy",
        basePoints: 3,
        verificationMode: "self",
        proofRequirement: "none",
        recurrence: "daily",
        startDate: today,
        nextOccurrenceDate: addCalendarDays(today, 1),
        dailyDeadlineTime: "23:59",
        active: false,
        createdBy: "AI"
      },
      {
        id: endedSeriesId,
        title: "Naturally ended daily",
        description: "",
        difficulty: "easy",
        basePoints: 3,
        verificationMode: "self",
        proofRequirement: "none",
        recurrence: "daily",
        startDate: today,
        nextOccurrenceDate: addCalendarDays(today, 1),
        endDate: today,
        dailyDeadlineTime: "23:59",
        active: false,
        createdBy: "AI"
      }
    ]);
    await getDb().insert(tasks).values([
      {
        id: pausedTaskId,
        seriesId: pausedSeriesId,
        occurrenceDate: today,
        title: "Legacy paused daily",
        description: "",
        type: "daily",
        difficulty: "easy",
        basePoints: 3,
        status: "pending",
        verificationMode: "self",
        proofRequirement: "none",
        source: "recurring",
        revealMode: "immediate",
        revealedAt: new Date(),
        deadlineAt: new Date(Date.now() + 86_400_000)
      },
      {
        id: endedTaskId,
        seriesId: endedSeriesId,
        occurrenceDate: today,
        title: "Naturally ended daily",
        description: "",
        type: "daily",
        difficulty: "easy",
        basePoints: 3,
        status: "pending",
        verificationMode: "self",
        proofRequirement: "none",
        source: "recurring",
        revealMode: "immediate",
        revealedAt: new Date(),
        deadlineAt: new Date(Date.now() + 86_400_000)
      }
    ]);
    await getDb().insert(auditLogs).values({
      id: createId("audit"),
      actor: "AI",
      action: "task_series.paused",
      entityType: "task_series",
      entityId: pausedSeriesId,
      summary: "Paused before immediate cancellation was implemented"
    });

    await seedDatabase();
    const reconciled = await reconcileSystem();
    expect(reconciled.paused_cancelled).toBe(1);
    expect(
      (await getDb().query.taskSeries.findFirst({ where: eq(taskSeries.id, pausedSeriesId) }))?.pausedAt
    ).toBeInstanceOf(Date);
    expect((await getDb().query.tasks.findFirst({ where: eq(tasks.id, pausedTaskId) }))?.status).toBe("cancelled");
    expect(
      (await getDb().query.taskSeries.findFirst({ where: eq(taskSeries.id, endedSeriesId) }))?.pausedAt
    ).toBeNull();
    expect((await getDb().query.tasks.findFirst({ where: eq(tasks.id, endedTaskId) }))?.status).toBe("pending");
  });

  it("does not cancel a historical pending occurrence when repairing a paused series", async () => {
    const seriesId = createId("series");
    const historicalTaskId = createId("task");
    const historicalDate = addCalendarDays(today, -2);
    await getDb().insert(taskSeries).values({
      id: seriesId,
      title: "Paused series with historical work",
      description: "Historical work remains visible for explicit handling",
      difficulty: "easy",
      basePoints: 3,
      verificationMode: "ai_review",
      proofRequirement: "text",
      recurrence: "daily",
      startDate: historicalDate,
      nextOccurrenceDate: addCalendarDays(today, 1),
      dailyDeadlineTime: "23:59",
      active: false,
      pausedAt: new Date(),
      createdBy: "AI"
    });
    await getDb().insert(tasks).values({
      id: historicalTaskId,
      seriesId,
      occurrenceDate: historicalDate,
      title: "Historical pending occurrence",
      description: "",
      type: "daily",
      difficulty: "easy",
      basePoints: 3,
      status: "pending",
      verificationMode: "ai_review",
      proofRequirement: "text",
      createdBy: "AI",
      source: "recurring",
      revealMode: "immediate",
      revealedAt: new Date(),
      deadlineAt: new Date(Date.now() + 86_400_000)
    });

    await reconcileSystem();
    expect(
      (await getDb().query.tasks.findFirst({ where: eq(tasks.id, historicalTaskId) }))?.status
    ).toBe("pending");
  });

  it("requires and exposes a rejection reason with the rejected submission", async () => {
    const created = await createTask({
      title: "Review reason task",
      description: "",
      type: "challenge",
      difficulty: "easy",
      base_points: 3,
      verification_mode: "ai_review",
      proof_requirement: "text",
      recurrence: "once",
      daily_deadline_time: "23:59",
      deadline: new Date(Date.now() + 86_400_000).toISOString(),
      reveal_mode: "immediate",
      idempotency_key: "integration-review-reason-task"
    });
    if (created.kind !== "task") throw new Error("Expected a one-time task");
    await submitTask(created.task.id, "My first explanation", []);

    await expect(
      manageTask({
        action: "review",
        task_id: created.task.id,
        decision: "reject",
        idempotency_key: "integration-reject-without-reason"
      })
    ).rejects.toMatchObject({ code: "review_reason_required" });
    expect((await getDb().query.tasks.findFirst({ where: eq(tasks.id, created.task.id) }))?.status).toBe("submitted");

    const reason = "请补充完成时间，以及你实际做了哪些部分。";
    await manageTask({
      action: "review",
      task_id: created.task.id,
      decision: "reject",
      reason,
      idempotency_key: "integration-reject-with-reason"
    });
    const detail = await queryTasks({
      task_id: created.task.id,
      include_proof: true,
      limit: 1
    });
    expect(detail.items[0]).toMatchObject({ status: "pending" });
    expect((detail.items[0] as any)?.submissions?.[0]).toMatchObject({
      status: "rejected",
      proofText: "My first explanation",
      reviewReason: reason
    });
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

  it("does not rewrite derived statistics during a clean reconciliation", async () => {
    await reconcileSystem();
    const beforeStats = await getDb().query.statistics.findFirst({ where: eq(statistics.id, 1) });
    const beforeActivity = await getDb().query.dailyActivity.findMany({
      orderBy: (row: any, { asc }: any) => [asc(row.activityDate)]
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await reconcileSystem()).toMatchObject({ generated: 0, expired: 0, paused_cancelled: 0 });
    const afterStats = await getDb().query.statistics.findFirst({ where: eq(statistics.id, 1) });
    const afterActivity = await getDb().query.dailyActivity.findMany({
      orderBy: (row: any, { asc }: any) => [asc(row.activityDate)]
    });
    expect(afterStats?.updatedAt.valueOf()).toBe(beforeStats?.updatedAt.valueOf());
    expect(afterActivity.map((row: any) => row.updatedAt.valueOf())).toEqual(
      beforeActivity.map((row: any) => row.updatedAt.valueOf())
    );
  });

  it("paginates task and audit history without duplicating rows", async () => {
    const taskIds = Array.from({ length: 13 }, () => createId("task"));
    const paginationBase = Date.now() + 60_000;
    await getDb().insert(tasks).values(taskIds.map((id, index) => ({
      id,
      title: `Pagination task ${index + 1}`,
      description: "",
      type: "challenge" as const,
      difficulty: "easy" as const,
      basePoints: 1,
      status: "pending" as const,
      verificationMode: "self" as const,
      proofRequirement: "none" as const,
      createdBy: "AI" as const,
      revealMode: "immediate" as const,
      revealedAt: new Date(paginationBase),
      createdAt: new Date(paginationBase),
      updatedAt: new Date(paginationBase)
    })));
    const firstTasks = await queryTasks({ status: "active", include_proof: false, limit: 7 });
    const secondTasks = await queryTasks({
      status: "active",
      include_proof: false,
      limit: 7,
      cursor: firstTasks.next_cursor!
    });
    expect(firstTasks.next_cursor).toBeTruthy();
    expect(secondTasks.items.length).toBeGreaterThan(0);
    expect(new Set([...firstTasks.items, ...secondTasks.items].map((row: any) => row.id)).size)
      .toBe(firstTasks.items.length + secondTasks.items.length);

    await getDb().insert(auditLogs).values(Array.from({ length: 13 }, (_, index) => ({
      id: createId("audit"),
      actor: "system" as const,
      action: "pagination.test",
      entityType: "system",
      summary: `Pagination audit ${index + 1}`,
      createdAt: new Date(paginationBase)
    })));
    const firstAudit = await queryHistory({ kind: "audit", limit: 5 });
    const secondAudit = await queryHistory({
      kind: "audit",
      limit: 5,
      cursor: firstAudit.next_cursor as string
    });
    expect(firstAudit.next_cursor).toBeTruthy();
    expect((secondAudit.audit as any[]).length).toBeGreaterThan(0);
    expect(new Set([...(firstAudit.audit as any[]), ...(secondAudit.audit as any[])].map((row) => row.id)).size)
      .toBe((firstAudit.audit as any[]).length + (secondAudit.audit as any[]).length);
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
    const redemptionFeed = await queryHistory({ kind: "events", after_sequence: 0, limit: 100 });
    expect((redemptionFeed.events as any[]).filter((event) =>
      event.type === "redemption.created" && event.aggregateId === first.redemption.id
    )).toHaveLength(1);
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
    await getDb().update(rewardItems).set({ active: false }).where(eq(rewardItems.id, rewardId));
    await seedDatabase();
    const repaired = await manageRewards({ action: "list", include_archived: false }) as any[];
    expect(repaired.some((reward: any) => reward.id === rewardId)).toBe(true);
    await manageRewards({
      action: "archive",
      reward_id: rewardId,
      idempotency_key: "integration-archive-custom-reward"
    });
    const active = await manageRewards({ action: "list", include_archived: false }) as any[];
    expect(active.some((reward: any) => reward.id === rewardId)).toBe(false);
    await seedDatabase();
    const stillArchived = await manageRewards({ action: "list", include_archived: false }) as any[];
    expect(stillArchived.some((reward: any) => reward.id === rewardId)).toBe(false);
    await manageRewards({
      action: "restore",
      reward_id: rewardId,
      idempotency_key: "integration-restore-custom-reward"
    });
    const restored = await manageRewards({ action: "list", include_archived: false }) as any[];
    expect(restored.some((reward: any) => reward.id === rewardId)).toBe(true);
    await manageRewards({
      action: "archive",
      reward_id: rewardId,
      idempotency_key: "integration-rearchive-custom-reward"
    });
  });

  it("prevents new AI image-only tasks without changing legacy proof support", async () => {
    const input = {
      title: "Image-only task",
      description: "Legacy-compatible proof",
      type: "daily" as const,
      difficulty: "easy" as const,
      base_points: 3,
      verification_mode: "ai_review" as const,
      proof_requirement: "image" as const,
      recurrence: "once" as const,
      daily_deadline_time: "23:59",
      reveal_mode: "immediate" as const,
      idempotency_key: "integration-ai-image-only"
    };
    await expect(createTask(input, "AI")).rejects.toMatchObject({
      code: "ai_image_only_proof_unsupported"
    });
    const legacy = await createTask(
      { ...input, idempotency_key: "integration-legacy-image-only" },
      "system"
    );
    expect(legacy.kind).toBe("task");
    if (legacy.kind !== "task") throw new Error("Expected legacy one-time task");
    expect(legacy.task.proofRequirement).toBe("image");
    legacyImageTaskId = legacy.task.id;
  });

  it("rejects new tasks whose deadline has already passed", async () => {
    await expect(
      createTask({
        title: "Already overdue",
        description: "",
        type: "challenge",
        difficulty: "easy",
        base_points: 3,
        verification_mode: "self",
        proof_requirement: "none",
        recurrence: "once",
        daily_deadline_time: "23:59",
        deadline: new Date(Date.now() - 60_000).toISOString(),
        reveal_mode: "immediate",
        idempotency_key: "integration-past-deadline"
      })
    ).rejects.toMatchObject({ code: "deadline_in_past" });
  });

  it("persists the full documented punishment intensity range", async () => {
    const updated = await updateUserSettings({
      timezone,
      user_label: "User",
      ai_label: "星沉",
      allowed_content: [],
      prohibited_content: [],
      punishment_intensity: 5,
      daily_penalty_limit: 20,
      punishments_paused: false,
      boundary_notes: ""
    });
    expect(updated.punishment_intensity).toBe(5);
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
    const taskHistory = await queryHistory({ kind: "tasks", limit: 100 }) as { tasks: any[] };
    expect(taskHistory.tasks.find((task) => task.id === created.task.id)?.penaltyAmount).toBe(5);
    expect((await getOverview()).statistics.balance).toBe(0);
  });

  it("records a zero-balance penalty as a safe no-op and rejects a negative balance correction", async () => {
    const penalty = await adjustPoints({
      kind: "penalty",
      amount: 5,
      reason: "No balance available",
      idempotency_key: "integration-zero-balance-penalty"
    });
    expect(penalty).toMatchObject({ entry: null, balance: 0, applied_amount: 0 });
    await expect(
      adjustPoints({
        kind: "correction",
        amount: -1,
        reason: "Would make balance negative",
        idempotency_key: "integration-negative-correction"
      })
    ).rejects.toMatchObject({ code: "insufficient_points" });
  });

  it("applies the user pause and shared daily limit to AI task-failure penalties", async () => {
    await adjustPoints({
      kind: "bonus",
      amount: 20,
      reason: "Boundary test balance",
      idempotency_key: "integration-boundary-balance"
    });
    await updateUserSettings({
      timezone,
      user_label: "User",
      ai_label: "星沉",
      allowed_content: [],
      prohibited_content: [],
      punishment_intensity: 5,
      daily_penalty_limit: 10,
      punishments_paused: true,
      boundary_notes: ""
    });
    const pausedTask = await createTask({
      title: "Paused failure task",
      description: "",
      type: "daily",
      difficulty: "easy",
      base_points: 20,
      verification_mode: "self",
      proof_requirement: "none",
      recurrence: "once",
      daily_deadline_time: "23:59",
      reveal_mode: "immediate",
      idempotency_key: "integration-paused-failure-task"
    });
    if (pausedTask.kind !== "task") throw new Error("Expected one-time task");
    const failInput = {
      action: "fail" as const,
      task_id: pausedTask.task.id,
      scope: "occurrence" as const,
      reason: "Boundary test failure",
      idempotency_key: "integration-paused-failure"
    };
    await expect(manageTask(failInput)).rejects.toMatchObject({ code: "punishments_paused" });
    expect(
      (await queryTasks({
        task_id: pausedTask.task.id,
        include_proof: false,
        limit: 1
      })).items[0]?.status
    ).toBe("pending");

    await updateUserSettings({
      timezone,
      user_label: "User",
      ai_label: "星沉",
      allowed_content: [],
      prohibited_content: [],
      punishment_intensity: 5,
      daily_penalty_limit: 10,
      punishments_paused: false,
      boundary_notes: ""
    });
    const manual = await adjustPoints({
      kind: "penalty",
      amount: 3,
      reason: "Uses part of the shared daily limit",
      idempotency_key: "integration-shared-limit-manual"
    });
    expect(manual.applied_amount).toBe(-3);
    expect((await manageTask(failInput)).penalty).toBe(2);

    const cappedTask = await createTask({
      title: "Fully capped failure task",
      description: "",
      type: "daily",
      difficulty: "easy",
      base_points: 20,
      verification_mode: "self",
      proof_requirement: "none",
      recurrence: "once",
      daily_deadline_time: "23:59",
      reveal_mode: "immediate",
      idempotency_key: "integration-capped-failure-task"
    });
    if (cappedTask.kind !== "task") throw new Error("Expected one-time task");
    const capped = await manageTask({
      action: "fail",
      task_id: cappedTask.task.id,
      scope: "occurrence",
      reason: "Daily limit already used",
      idempotency_key: "integration-capped-failure"
    });
    expect(capped.penalty).toBe(0);
    expect((await getOverview()).statistics.balance).toBe(15);
  });

  it("records durable task events and delivers signed Webhooks with retry state", async () => {
    const requests: Array<{ body: string; headers: Record<string, string | string[] | undefined> }> = [];
    let responseStatus = 204;
    let responseDelayMs = 0;
    const receiver = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      requests.push({ body: Buffer.concat(chunks).toString("utf8"), headers: { ...request.headers } });
      if (responseDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
      }
      response.statusCode = responseStatus;
      if (responseStatus === 503) response.setHeader("Retry-After", "1");
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      receiver.once("error", onError);
      receiver.listen(0, "127.0.0.1", () => {
        receiver.off("error", onError);
        resolve();
      });
    });
    const address = receiver.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/phosphene/events`;
    try {
      await updateWebhookSettings({
        enabled: true,
        url,
        event_types: ["task.submitted", "task.completed", "redemption.created"]
      });
      const { signing_secret: signingSecret } = await rotateWebhookSecret();

      const selfTask = await createTask({
        title: "Webhook self completion",
        description: "Emits a completion event",
        type: "challenge",
        difficulty: "easy",
        base_points: 2,
        verification_mode: "self",
        proof_requirement: "none",
        recurrence: "once",
        daily_deadline_time: "23:59",
        reveal_mode: "immediate",
        idempotency_key: "integration-webhook-self-task"
      });
      if (selfTask.kind !== "task") throw new Error("Expected one-time self task");
      await submitTask(selfTask.task.id, "", []);

      const reviewTask = await createTask({
        title: "Webhook review submission",
        description: "Emits a submitted event",
        type: "challenge",
        difficulty: "easy",
        base_points: 2,
        verification_mode: "ai_review",
        proof_requirement: "text",
        recurrence: "once",
        daily_deadline_time: "23:59",
        reveal_mode: "immediate",
        idempotency_key: "integration-webhook-review-task"
      });
      if (reviewTask.kind !== "task") throw new Error("Expected one-time review task");
      await submitTask(reviewTask.task.id, "Evidence for AI review", []);
      const approval = {
        action: "review" as const,
        task_id: reviewTask.task.id,
        decision: "approve" as const,
        idempotency_key: "integration-webhook-review-approval"
      };
      await manageTask(approval);
      await manageTask(approval);

      const feed = await queryHistory({ kind: "events", after_sequence: 0, limit: 100 });
      expect((feed.events as any[]).some((event) =>
        event.type === "task.completed" && event.aggregateId === selfTask.task.id
      )).toBe(true);
      expect((feed.events as any[]).some((event) =>
        event.type === "task.submitted" && event.aggregateId === reviewTask.task.id
      )).toBe(true);
      expect((feed.events as any[]).filter((event) =>
        event.type === "task.completed" && event.aggregateId === reviewTask.task.id
      )).toHaveLength(1);
      expect(feed.next_sequence).toBeGreaterThan(0);

      for (let index = 0; index < 3; index += 1) {
        const claim = await claimWebhookDelivery();
        expect(claim).not.toBeNull();
        await deliverWebhookClaim(claim!);
      }
      expect(requests).toHaveLength(3);
      for (const request of requests) {
        const eventId = String(request.headers["x-phosphene-event-id"]);
        const timestamp = String(request.headers["x-phosphene-timestamp"]);
        expect(request.headers["idempotency-key"]).toBe(eventId);
        expect(request.headers["x-phosphene-signature"]).toBe(
          `v1=${signWebhookBody(signingSecret, timestamp, request.body)}`
        );
        expect(JSON.parse(request.body)).toMatchObject({ id: eventId, version: 1 });
      }
      expect(
        (await getDb().query.webhookDeliveries.findMany()).filter((row: any) => row.status === "delivered")
      ).toHaveLength(3);

      responseStatus = 503;
      const testEvent = await createWebhookTestEvent();
      const failedAt = Date.now();
      const failedClaim = await claimWebhookDelivery();
      expect(failedClaim?.event.id).toBe(testEvent.event_id);
      await deliverWebhookClaim(failedClaim!);
      const failed = await getDb().query.webhookDeliveries.findFirst({
        where: eq(webhookDeliveries.id, failedClaim!.deliveryId)
      });
      expect(failed).toMatchObject({ status: "pending", attemptCount: 1, lastStatusCode: 503 });
      expect(failed!.nextAttemptAt.valueOf()).toBeGreaterThanOrEqual(failedAt + 900);

      const expiredAt = new Date(Date.now() - 1_000);
      await getDb().update(webhookDeliveries).set({
        status: "processing",
        attemptCount: WEBHOOK_MAX_ATTEMPTS - 1,
        leaseToken: "expired-test-lease",
        leaseExpiresAt: expiredAt,
        updatedAt: expiredAt
      }).where(eq(webhookDeliveries.id, failedClaim!.deliveryId));
      const reclaimed = await claimWebhookDelivery();
      expect(reclaimed).toMatchObject({
        deliveryId: failedClaim!.deliveryId,
        attempt: WEBHOOK_MAX_ATTEMPTS
      });
      expect(reclaimed!.leaseToken).not.toBe("expired-test-lease");
      expect(await markWebhookFailed(
        reclaimed!.deliveryId,
        reclaimed!.leaseToken,
        "Terminal integration failure",
        503
      )).toMatchObject({ stale: false, status: "dead_letter" });
      expect(await getDb().query.webhookDeliveries.findFirst({
        where: eq(webhookDeliveries.id, failedClaim!.deliveryId)
      })).toMatchObject({ status: "dead_letter", attemptCount: WEBHOOK_MAX_ATTEMPTS });

      await retryWebhookDelivery(failedClaim!.deliveryId);
      expect(await getDb().query.webhookDeliveries.findFirst({
        where: eq(webhookDeliveries.id, failedClaim!.deliveryId)
      })).toMatchObject({ status: "pending", attemptCount: 0, lastStatusCode: null });

      responseStatus = 204;
      responseDelayMs = 100;
      const timeoutClaim = await claimWebhookDelivery();
      expect(timeoutClaim?.deliveryId).toBe(failedClaim!.deliveryId);
      await deliverWebhookClaim(timeoutClaim!, 25);
      expect(await getDb().query.webhookDeliveries.findFirst({
        where: eq(webhookDeliveries.id, failedClaim!.deliveryId)
      })).toMatchObject({ status: "pending", attemptCount: 1, lastStatusCode: null });

      responseDelayMs = 0;
      const recoveredClaim = await claimWebhookDelivery(new Date(Date.now() + 6_000));
      expect(recoveredClaim).toMatchObject({
        deliveryId: timeoutClaim!.deliveryId,
        attempt: 2
      });
      expect(recoveredClaim!.event.id).toBe(timeoutClaim!.event.id);
      await deliverWebhookClaim(recoveredClaim!);
      expect(
        requests.slice(-2).map((request) => request.headers["x-phosphene-event-id"])
      ).toEqual([timeoutClaim!.event.id, timeoutClaim!.event.id]);
      expect(await getDb().query.webhookDeliveries.findFirst({
        where: eq(webhookDeliveries.id, failedClaim!.deliveryId)
      })).toMatchObject({ status: "delivered", attemptCount: 2, lastStatusCode: 204 });
      expect((await getWebhookSettings()).deliveries).toMatchObject({ delivered: 4 });
    } finally {
      await updateWebhookSettings({
        enabled: false,
        url,
        event_types: ["task.submitted", "task.completed", "redemption.created"]
      }).catch(() => undefined);
      await new Promise<void>((resolve, reject) => receiver.close((error) => error ? reject(error) : resolve()));
    }
    await expect(createWebhookTestEvent()).rejects.toMatchObject({ code: "webhook_disabled" });
  });

  it("round-trips images and idempotency records through an in-place streamed backup", async () => {
    const sourceImage = await sharp({
      create: {
        width: 48,
        height: 32,
        channels: 3,
        background: { r: 72, g: 83, b: 128 }
      }
    })
      .png()
      .toBuffer();
    const [stored] = await saveProofImages([
      {
        fieldname: "images",
        originalname: "proof.png",
        encoding: "7bit",
        mimetype: "image/png",
        size: sourceImage.byteLength,
        buffer: sourceImage
      } as Express.Multer.File
    ]);
    await submitTask(legacyImageTaskId, "Legacy image proof", [stored]);
    const originalBefore = await getObject(stored.objectKey);
    const balanceBeforeBackup = (await getOverview()).statistics.balance;
    await updateWebhookSettings({
      enabled: false,
      url: "https://backup-source.invalid/events",
      event_types: ["task.completed"]
    });
    const eventsBeforeBackup = await getDb().select().from(domainEvents);
    const deliveriesBeforeBackup = await getDb().select().from(webhookDeliveries);
    const backupPath = path.join(config.BACKUP_TEMP_PATH, "integration-backup.zip");
    await fs.rm(backupPath, { force: true });
    try {
      await exportBackupToFile(backupPath);
      expect((await fs.stat(backupPath)).size).toBeGreaterThan(0);
      await updateWebhookSettings({
        enabled: true,
        url: "https://backup-target.invalid/events",
        event_types: ["task.submitted", "redemption.created"]
      });
      const { signing_secret: targetSigningSecret } = await rotateWebhookSecret();
      await createWebhookTestEvent();
      await updateWebhookSettings({
        enabled: false,
        url: "https://backup-target.invalid/events",
        event_types: ["task.submitted", "redemption.created"]
      });
      await adjustPoints({
        kind: "bonus",
        amount: 99,
        reason: "Temporary post-backup mutation",
        idempotency_key: "integration-post-backup-bonus"
      });
      expect((await getOverview()).statistics.balance).toBe(balanceBeforeBackup + 99);

      await restoreBackupFromFile(backupPath);
      expect((await getOverview()).statistics.balance).toBe(balanceBeforeBackup);
      expect(await getWebhookSettings()).toMatchObject({
        enabled: false,
        url: "https://backup-target.invalid/events",
        event_types: ["task.submitted", "redemption.created"]
      });
      expect((await getDb().query.webhookConfig.findFirst({ where: eq(webhookConfig.id, 1) }))?.signingSecret)
        .toBe(targetSigningSecret);
      expect(await getDb().select().from(domainEvents)).toHaveLength(eventsBeforeBackup.length);
      expect(await getDb().select().from(webhookDeliveries)).toHaveLength(deliveriesBeforeBackup.length);
      const restoredAsset = await getDb().query.proofAssets.findFirst({
        where: eq(proofAssets.id, stored.id)
      });
      expect(restoredAsset).toBeDefined();
      expect(restoredAsset?.objectKey).not.toBe(stored.objectKey);
      expect((await getObject(restoredAsset!.objectKey)).equals(originalBefore)).toBe(true);

      await adjustPoints({
        kind: "bonus",
        amount: 99,
        reason: "Temporary post-backup mutation",
        idempotency_key: "integration-post-backup-bonus"
      });
      expect((await getOverview()).statistics.balance).toBe(balanceBeforeBackup + 99);
    } finally {
      await fs.rm(backupPath, { force: true });
    }
  });

  it("waits for active requests and blocks new work during backup maintenance", async () => {
    const backupPath = path.join(config.BACKUP_TEMP_PATH, "integration-maintenance.zip");
    await fs.rm(backupPath, { force: true });
    const release = beginApplicationRequest();
    let completed = false;
    const exporting = exportBackupToFile(backupPath).then(() => {
      completed = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getActiveBackupOperation()).toBe("export");
      expect(completed).toBe(false);
      expect(() => beginApplicationRequest()).toThrowError(/temporarily unavailable/i);
    } finally {
      release();
      await exporting;
      await fs.rm(backupPath, { force: true });
    }
    expect(completed).toBe(true);
    expect(getActiveBackupOperation()).toBeNull();
  });

  it("restores version 1 backups without retaining newer idempotency records", async () => {
    const sourcePath = path.join(config.BACKUP_TEMP_PATH, "integration-v2-source.zip");
    const legacyPath = path.join(config.BACKUP_TEMP_PATH, "integration-v1-compat.zip");
    await Promise.all([
      fs.rm(sourcePath, { force: true }),
      fs.rm(legacyPath, { force: true })
    ]);
    try {
      await exportBackupToFile(sourcePath);
      const manifest = await readBackupManifest(sourcePath);
      manifest.version = 1;
      delete manifest.objects;
      const assets = await getDb()
        .select({
          objectKey: proofAssets.objectKey,
          previewKey: proofAssets.previewKey
        })
        .from(proofAssets);
      await writeLegacyBackup(legacyPath, manifest, assets);
      const balanceBeforeMutation = (await getOverview()).statistics.balance;
      await adjustPoints({
        kind: "bonus",
        amount: 1,
        reason: "Post-version-one-backup mutation",
        idempotency_key: "integration-v1-post-backup"
      });
      await restoreBackupFromFile(legacyPath);
      expect((await getOverview()).statistics.balance).toBe(balanceBeforeMutation);
      await adjustPoints({
        kind: "bonus",
        amount: 1,
        reason: "Post-version-one-backup mutation",
        idempotency_key: "integration-v1-post-backup"
      });
      expect((await getOverview()).statistics.balance).toBe(balanceBeforeMutation + 1);
      expect(await getDb().query.proofAssets.findFirst()).toBeDefined();
    } finally {
      await Promise.all([
        fs.rm(sourcePath, { force: true }),
        fs.rm(legacyPath, { force: true })
      ]);
    }
  });

  it("rejects proof object keys that could leave private storage", () => {
    expect(isValidProofObjectKey("proofs/proof_safe/original.webp")).toBe(true);
    expect(isValidProofObjectKey("../phosphene.sqlite")).toBe(false);
    expect(isValidProofObjectKey("proofs/proof_safe/../../phosphene.sqlite")).toBe(false);
    expect(() => getObjectPath("../phosphene.sqlite")).toThrowError(/invalid/i);
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
