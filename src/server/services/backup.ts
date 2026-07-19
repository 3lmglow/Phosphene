import JSZip from "jszip";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { seedDatabase } from "../db/seed";
import {
  achievementUnlocks,
  appSettings,
  auditLogs,
  dailyActivity,
  pointLedger,
  proofAssets,
  redemptions,
  rewardItems,
  statistics,
  taskSeries,
  taskSubmissions,
  tasks
} from "../db/schema";
import { AppError } from "../errors";
import { getObject, putRestoredObject, removeStoredProofs, type StoredProof } from "./storage";
import { reconcileSystem } from "./domain";

const timestampFields = new Set([
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

function reviveRows(rows: any[]): any[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value != null && timestampFields.has(key) ? new Date(String(value)) : value
      ])
    )
  );
}

export async function exportBackup(): Promise<Buffer> {
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
        exportedAt: new Date().toISOString(),
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

export async function restoreBackup(buffer: Buffer): Promise<void> {
  let zip: JSZip;
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

  const incomingProofs = reviveRows(data.proofAssets) as StoredProof[];
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
    await db.transaction(async (tx: any) => {
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
        await tx.update(appSettings).set(settings).where(eq(appSettings.id, 1));
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
        await tx.update(statistics).set(stats).where(eq(statistics.id, 1));
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
  // Reapply current built-in definitions and retire superseded defaults after
  // importing an archive created by an older Phosphene release.
  await seedDatabase();
  await reconcileSystem();
}
