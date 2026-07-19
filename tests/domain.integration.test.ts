import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
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
  pointLedger,
  proofAssets,
  rewardItems,
  tasks,
  userAccount
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
  queryTasks,
  reconcileSystem,
  redeemReward,
  submitTask,
  updateUserSettings
} from "../src/server/services/domain";
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
    const backupPath = path.join(config.BACKUP_TEMP_PATH, "integration-backup.zip");
    await fs.rm(backupPath, { force: true });
    try {
      await exportBackupToFile(backupPath);
      expect((await fs.stat(backupPath)).size).toBeGreaterThan(0);
      await adjustPoints({
        kind: "bonus",
        amount: 99,
        reason: "Temporary post-backup mutation",
        idempotency_key: "integration-post-backup-bonus"
      });
      expect((await getOverview()).statistics.balance).toBe(balanceBeforeBackup + 99);

      await restoreBackupFromFile(backupPath);
      expect((await getOverview()).statistics.balance).toBe(balanceBeforeBackup);
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
