import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform, type Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { ZipArchive, type ZipEntryData } from "archiver";
import { eq, getTableColumns } from "drizzle-orm";
import sharp from "sharp";
import { openPromise, type Entry, type ZipFile } from "yauzl";
import { MAX_PROOF_IMAGE_PIXELS } from "../../shared/constants";
import { getDb } from "../db/client";
import { seedDatabase } from "../db/seed";
import {
  achievementUnlocks,
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
import { AppError } from "../errors";
import { createId } from "../lib/ids";
import { reconcileSystem } from "./domain";
import {
  deleteObject,
  getObjectPath,
  isValidProofObjectKey,
  removeStoredProofs,
  type StoredProof
} from "./storage";

const BACKUP_MANIFEST = "phosphene-backup.json";
const BACKUP_FORMAT_VERSION = 2;
const MAX_BACKUP_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_BACKUP_ROWS = 500_000;
const MAX_BACKUP_ENTRIES = 200_000;
const MAX_BACKUP_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024;

export const MAX_BACKUP_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

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

const backupTables = {
  settings: appSettings,
  taskSeries,
  tasks,
  taskSubmissions,
  proofAssets,
  rewardItems,
  redemptions,
  pointLedger,
  dailyActivity,
  statistics,
  achievementUnlocks,
  auditLogs,
  idempotencyKeys
} as const;

type BackupData = {
  -readonly [K in keyof typeof backupTables]: Record<string, unknown>[];
};

type ProofArchiveTarget = {
  targetKey: string;
  expectedSha256?: string;
  expectedSize?: number;
  expectedWidth?: number;
  expectedHeight?: number;
};

type BackupObjectMetadata = Record<
  string,
  { sizeBytes: number; sha256: string }
>;

type ParsedBackup = {
  version: number;
  data: BackupData;
  objects: BackupObjectMetadata;
};

let activeBackupOperation: "export" | "restore" | null = null;
let backupOperationPending: "export" | "restore" | null = null;
let activeApplicationRequests = 0;
const requestDrainWaiters = new Set<() => void>();

export function getActiveBackupOperation(): "export" | "restore" | null {
  return activeBackupOperation ?? backupOperationPending;
}

export function beginApplicationRequest(): () => void {
  if (getActiveBackupOperation()) {
    throw new AppError(
      503,
      "backup_maintenance",
      "Phosphene is temporarily unavailable while a backup operation completes"
    );
  }
  activeApplicationRequests += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeApplicationRequests -= 1;
    if (activeApplicationRequests === 0) {
      for (const resolve of requestDrainWaiters) resolve();
      requestDrainWaiters.clear();
    }
  };
}

async function waitForApplicationRequests(): Promise<void> {
  if (activeApplicationRequests === 0) return;
  await new Promise<void>((resolve) => requestDrainWaiters.add(resolve));
}

async function withBackupOperation<T>(
  operation: "export" | "restore",
  work: () => Promise<T>
): Promise<T> {
  if (getActiveBackupOperation()) {
    throw new AppError(
      409,
      "backup_busy",
      `A backup ${getActiveBackupOperation()} operation is already in progress`
    );
  }
  backupOperationPending = operation;
  try {
    await waitForApplicationRequests();
    activeBackupOperation = operation;
    return await work();
  } finally {
    activeBackupOperation = null;
    backupOperationPending = null;
  }
}

function invalidBackup(message: string): AppError {
  return new AppError(400, "invalid_backup", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function reviveRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value != null && timestampFields.has(key) ? new Date(String(value)) : value
      ])
    )
  );
}

function sanitizeRows(
  table: (typeof backupTables)[keyof typeof backupTables],
  value: unknown,
  name: string
): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw invalidBackup(`Backup table “${name}” is missing`);
  const allowedKeys = new Set(Object.keys(getTableColumns(table as any)));
  return value.map((row, index) => {
    if (!isRecord(row)) throw invalidBackup(`Backup table “${name}” row ${index + 1} is invalid`);
    return Object.fromEntries(
      Object.entries(row).filter(([key]) => allowedKeys.has(key))
    );
  });
}

function parseManifest(buffer: Buffer): ParsedBackup {
  let manifest: unknown;
  try {
    manifest = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw invalidBackup("Backup manifest is not valid JSON");
  }
  if (
    !isRecord(manifest) ||
    manifest.format !== "phosphene-backup" ||
    ![1, BACKUP_FORMAT_VERSION].includes(Number(manifest.version)) ||
    !isRecord(manifest.data)
  ) {
    throw new AppError(400, "unsupported_backup", "This backup format is not supported");
  }
  const version = Number(manifest.version);
  const data = {} as BackupData;
  let rowCount = 0;
  for (const [name, table] of Object.entries(backupTables) as Array<
    [keyof BackupData, (typeof backupTables)[keyof typeof backupTables]]
  >) {
    const source =
      name === "idempotencyKeys" && version === 1
        ? []
        : manifest.data[name];
    const rows = sanitizeRows(table, source, name);
    rowCount += rows.length;
    if (rowCount > MAX_BACKUP_ROWS) {
      throw invalidBackup(`Backup contains more than ${MAX_BACKUP_ROWS} database rows`);
    }
    data[name] = rows;
  }
  if (data.settings.length !== 1 || data.statistics.length !== 1) {
    throw invalidBackup("Backup must contain exactly one settings row and one statistics row");
  }
  let objects: BackupObjectMetadata = {};
  if (version === BACKUP_FORMAT_VERSION) {
    if (!isRecord(manifest.objects)) {
      throw invalidBackup("Backup object metadata is missing");
    }
    objects = Object.fromEntries(
      Object.entries(manifest.objects).map(([name, value]) => {
        if (
          !isRecord(value) ||
          !Number.isSafeInteger(value.sizeBytes) ||
          Number(value.sizeBytes) < 1 ||
          Number(value.sizeBytes) > MAX_BACKUP_OBJECT_BYTES ||
          typeof value.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.sha256)
        ) {
          throw invalidBackup(`Backup object metadata for "${name}" is invalid`);
        }
        return [
          name,
          {
            sizeBytes: Number(value.sizeBytes),
            sha256: value.sha256
          }
        ];
      })
    );
  }
  return { version, data, objects };
}

function validateZipEntryName(name: string): void {
  if (
    !name ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    name.split("/").some((part) => part === ".." || part === ".")
  ) {
    throw invalidBackup("Backup contains an unsafe archive path");
  }
}

async function readEntryBuffer(
  zip: ZipFile,
  entry: Entry,
  limit: number
): Promise<Buffer> {
  if (entry.uncompressedSize > limit) {
    throw invalidBackup(`Archive entry “${entry.fileName}” is too large`);
  }
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) throw invalidBackup(`Archive entry “${entry.fileName}” is too large`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

async function writeProofEntry(
  zip: ZipFile,
  entry: Entry,
  target: ProofArchiveTarget
): Promise<void> {
  if (entry.uncompressedSize > MAX_BACKUP_OBJECT_BYTES) {
    throw invalidBackup(`Proof object “${entry.fileName}” is too large`);
  }
  if (target.expectedSize != null && entry.uncompressedSize !== target.expectedSize) {
    throw invalidBackup(`Proof object “${entry.fileName}” has an unexpected size`);
  }
  const targetPath = getObjectPath(target.targetKey);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const digest = createHash("sha256");
  let size = 0;
  let targetCreated = false;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      if (size > MAX_BACKUP_OBJECT_BYTES) {
        callback(invalidBackup(`Proof object “${entry.fileName}” is too large`));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    const sourceStream = await zip.openReadStreamPromise(entry);
    const targetStream = createWriteStream(targetPath, { flags: "wx", mode: 0o600 });
    targetStream.once("open", () => {
      targetCreated = true;
    });
    await pipeline(
      sourceStream,
      meter,
      targetStream
    );
    if (target.expectedSize != null && size !== target.expectedSize) {
      throw invalidBackup(`Proof object “${entry.fileName}” has an unexpected size`);
    }
    if (target.expectedSha256 && digest.digest("hex") !== target.expectedSha256) {
      throw invalidBackup(`Proof object “${entry.fileName}” failed its integrity check`);
    }
    const metadata = await sharp(targetPath, {
      failOn: "warning",
      limitInputPixels: MAX_PROOF_IMAGE_PIXELS
    }).metadata();
    if (
      metadata.format !== "webp" ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > MAX_PROOF_IMAGE_PIXELS
    ) {
      throw invalidBackup(`Proof object “${entry.fileName}” is not a safe WebP image`);
    }
    if (
      target.expectedWidth != null &&
      target.expectedHeight != null &&
      (metadata.width !== target.expectedWidth || metadata.height !== target.expectedHeight)
    ) {
      throw invalidBackup(`Proof object “${entry.fileName}” dimensions do not match the manifest`);
    }
  } catch (error) {
    if (targetCreated) await fs.rm(targetPath, { force: true });
    throw error;
  }
}

async function readBackupData(): Promise<BackupData> {
  return getDb().transaction(async (tx: any) => ({
    settings: await tx.select().from(appSettings),
    taskSeries: await tx.select().from(taskSeries),
    tasks: await tx.select().from(tasks),
    taskSubmissions: await tx.select().from(taskSubmissions),
    proofAssets: await tx.select().from(proofAssets),
    rewardItems: await tx.select().from(rewardItems),
    redemptions: await tx.select().from(redemptions),
    pointLedger: await tx.select().from(pointLedger),
    dailyActivity: await tx.select().from(dailyActivity),
    statistics: await tx.select().from(statistics),
    achievementUnlocks: await tx.select().from(achievementUnlocks),
    auditLogs: await tx.select().from(auditLogs),
    idempotencyKeys: await tx.select().from(idempotencyKeys)
  }));
}

async function inspectStoredObject(key: string): Promise<{
  sizeBytes: number;
  sha256: string;
}> {
  const filePath = getObjectPath(key);
  const stats = await fs.stat(filePath);
  if (
    !stats.isFile() ||
    stats.size < 1 ||
    stats.size > MAX_BACKUP_OBJECT_BYTES
  ) {
    throw new AppError(
      500,
      "invalid_stored_object",
      `Stored proof object "${key}" has an invalid size`
    );
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  return { sizeBytes: stats.size, sha256: digest.digest("hex") };
}

async function buildBackupObjectMetadata(
  assets: Record<string, unknown>[]
): Promise<BackupObjectMetadata> {
  const objects: BackupObjectMetadata = {};
  for (const asset of assets) {
    const objectKey = String(asset.objectKey ?? "");
    const previewKey = String(asset.previewKey ?? "");
    if (
      !isValidProofObjectKey(objectKey) ||
      !isValidProofObjectKey(previewKey) ||
      objectKey === previewKey
    ) {
      throw new AppError(
        500,
        "invalid_stored_object_key",
        "A stored proof object key is invalid"
      );
    }
    for (const key of [objectKey, previewKey]) {
      const archiveName = `objects/${key}`;
      if (objects[archiveName]) {
        throw new AppError(
          500,
          "duplicate_stored_object_key",
          "Stored proof object keys are not unique"
        );
      }
      objects[archiveName] = await inspectStoredObject(key);
    }
    if (
      objects[`objects/${objectKey}`].sizeBytes !== Number(asset.sizeBytes) ||
      objects[`objects/${objectKey}`].sha256 !== String(asset.sha256)
    ) {
      throw new AppError(
        500,
        "stored_object_integrity",
        `Stored proof object "${objectKey}" does not match its database metadata`
      );
    }
  }
  return objects;
}

export async function streamBackup(output: Writable): Promise<void> {
  return withBackupOperation("export", async () => {
    const data = await readBackupData();
    const objects = await buildBackupObjectMetadata(data.proofAssets);
    const manifest = Buffer.from(
      JSON.stringify(
        {
          format: "phosphene-backup",
          version: BACKUP_FORMAT_VERSION,
          exportedAt: new Date().toISOString(),
          data,
          objects
        },
        null,
        2
      )
    );
    if (manifest.byteLength > MAX_BACKUP_MANIFEST_BYTES) {
      throw new AppError(
        413,
        "backup_manifest_too_large",
        "The database manifest is too large to export safely"
      );
    }

    const archive = new ZipArchive({
      zlib: { level: 6 },
      forceZip64: true
    });
    archive.pipe(output);
    const archiveDone = finished(archive);
    const outputDone = finished(output);
    archive.once("warning", (error) => archive.emit("error", error));
    try {
      archive.append(manifest, { name: BACKUP_MANIFEST });
      for (const archiveName of Object.keys(objects)) {
        const objectKey = archiveName.slice("objects/".length);
        const entry: ZipEntryData = { name: archiveName, store: true };
        archive.file(getObjectPath(objectKey), entry);
      }
      await archive.finalize();
      await Promise.all([archiveDone, outputDone]);
    } catch (error) {
      archive.abort();
      output.destroy(error instanceof Error ? error : new Error("Backup export failed"));
      await Promise.allSettled([archiveDone, outputDone]);
      throw error;
    }
  });
}

export async function exportBackupToFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await streamBackup(createWriteStream(filePath, { flags: "wx", mode: 0o600 }));
  } catch (error) {
    await fs.rm(filePath, { force: true });
    throw error;
  }
}

function prepareProofTargets(parsed: ParsedBackup): Map<string, ProofArchiveTarget> {
  const { data, objects, version } = parsed;
  const expected = new Map<string, ProofArchiveTarget>();
  const restoreSuffix = createId("restore");
  data.proofAssets = data.proofAssets.map((row, index) => {
    const id = String(row.id ?? "");
    const objectKey = String(row.objectKey ?? "");
    const previewKey = String(row.previewKey ?? "");
    const sha256 = String(row.sha256 ?? "");
    const sizeBytes = Number(row.sizeBytes);
    const width = Number(row.width);
    const height = Number(row.height);
    if (
      !/^proof_[A-Za-z0-9_-]+$/.test(id) ||
      !isValidProofObjectKey(objectKey) ||
      !isValidProofObjectKey(previewKey) ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 1 ||
      sizeBytes > MAX_BACKUP_OBJECT_BYTES ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > MAX_PROOF_IMAGE_PIXELS
    ) {
      throw invalidBackup(`Proof asset row ${index + 1} is invalid`);
    }
    const targetBase = `${id}-${restoreSuffix}`;
    const restoredObjectKey = `proofs/${targetBase}/original.webp`;
    const restoredPreviewKey = `proofs/${targetBase}/preview.webp`;
    const sourceObjectName = `objects/${objectKey}`;
    const sourcePreviewName = `objects/${previewKey}`;
    if (expected.has(sourceObjectName) || expected.has(sourcePreviewName)) {
      throw invalidBackup("Backup contains duplicate proof object references");
    }
    const originalMetadata = objects[sourceObjectName];
    const previewMetadata = objects[sourcePreviewName];
    if (
      version === BACKUP_FORMAT_VERSION &&
      (!originalMetadata ||
        !previewMetadata ||
        originalMetadata.sizeBytes !== sizeBytes ||
        originalMetadata.sha256 !== sha256)
    ) {
      throw invalidBackup("Backup proof metadata does not match its database rows");
    }
    expected.set(sourceObjectName, {
      targetKey: restoredObjectKey,
      expectedSha256: originalMetadata?.sha256 ?? sha256,
      expectedSize: originalMetadata?.sizeBytes ?? sizeBytes,
      expectedWidth: width,
      expectedHeight: height
    });
    expected.set(sourcePreviewName, {
      targetKey: restoredPreviewKey,
      expectedSha256: previewMetadata?.sha256,
      expectedSize: previewMetadata?.sizeBytes
    });
    return {
      ...row,
      objectKey: restoredObjectKey,
      previewKey: restoredPreviewKey,
      mimeType: "image/webp"
    };
  });
  if (
    version === BACKUP_FORMAT_VERSION &&
    (Object.keys(objects).length !== expected.size ||
      Object.keys(objects).some((name) => !expected.has(name)))
  ) {
    throw invalidBackup("Backup contains unexpected object metadata");
  }
  return expected;
}

async function replaceDatabase(data: BackupData): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx: any) => {
    await tx.delete(idempotencyKeys);
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
    delete settings.id;
    delete settings.initialized;
    delete settings.createdAt;
    await tx.update(appSettings).set(settings).where(eq(appSettings.id, 1));

    if (data.taskSeries.length) await tx.insert(taskSeries).values(reviveRows(data.taskSeries));
    if (data.tasks.length) await tx.insert(tasks).values(reviveRows(data.tasks));
    if (data.taskSubmissions.length) {
      await tx.insert(taskSubmissions).values(reviveRows(data.taskSubmissions));
    }
    if (data.proofAssets.length) await tx.insert(proofAssets).values(reviveRows(data.proofAssets));
    if (data.rewardItems.length) await tx.insert(rewardItems).values(reviveRows(data.rewardItems));
    if (data.redemptions.length) await tx.insert(redemptions).values(reviveRows(data.redemptions));
    if (data.pointLedger.length) await tx.insert(pointLedger).values(reviveRows(data.pointLedger));
    if (data.dailyActivity.length) {
      await tx.insert(dailyActivity).values(reviveRows(data.dailyActivity));
    }

    const stats = reviveRows(data.statistics)[0];
    delete stats.id;
    await tx.update(statistics).set(stats).where(eq(statistics.id, 1));

    if (data.achievementUnlocks.length) {
      await tx.insert(achievementUnlocks).values(reviveRows(data.achievementUnlocks));
    }
    if (data.auditLogs.length) await tx.insert(auditLogs).values(reviveRows(data.auditLogs));
    if (data.idempotencyKeys.length) {
      await tx.insert(idempotencyKeys).values(reviveRows(data.idempotencyKeys));
    }
    await tx.insert(auditLogs).values({
      id: createId("audit"),
      actor: "user",
      action: "backup.restored",
      entityType: "system",
      summary: "Application data restored from a trusted backup"
    });
  });
}

export async function restoreBackupFromFile(filePath: string): Promise<void> {
  return withBackupOperation("restore", async () => {
    const archiveStats = await fs.stat(filePath).catch(() => null);
    if (
      !archiveStats ||
      !archiveStats.isFile() ||
      archiveStats.size < 1 ||
      archiveStats.size > MAX_BACKUP_ARCHIVE_BYTES
    ) {
      throw invalidBackup("The selected backup file has an invalid size");
    }

    let zip: ZipFile;
    try {
      zip = await openPromise(filePath, {
        autoClose: true,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true
      });
    } catch {
      throw invalidBackup("The selected file is not a valid Phosphene backup");
    }
    if (zip.entryCount < 1 || zip.entryCount > MAX_BACKUP_ENTRIES) {
      zip.close();
      throw invalidBackup("Backup contains an invalid number of archive entries");
    }

    let parsed: ParsedBackup | null = null;
    let data: BackupData | null = null;
    let expected = new Map<string, ProofArchiveTarget>();
    const createdObjectKeys = new Set<string>();
    const seen = new Set<string>();
    let totalUncompressed = 0;
    let entryIndex = 0;
    let databaseReplaced = false;
    try {
      for await (const entry of zip.eachEntry()) {
        entryIndex += 1;
        validateZipEntryName(entry.fileName);
        if (!entry.canDecodeFileData() || entry.isEncrypted()) {
          throw invalidBackup(`Archive entry “${entry.fileName}” cannot be decoded safely`);
        }
        totalUncompressed += entry.uncompressedSize;
        if (totalUncompressed > MAX_BACKUP_UNCOMPRESSED_BYTES) {
          throw invalidBackup("Backup expands beyond the allowed size");
        }

        if (entryIndex === 1) {
          if (entry.fileName !== BACKUP_MANIFEST) {
            throw invalidBackup("Backup manifest must be the first archive entry");
          }
          parsed = parseManifest(
            await readEntryBuffer(zip, entry, MAX_BACKUP_MANIFEST_BYTES)
          );
          data = parsed.data;
          expected = prepareProofTargets(parsed);
          continue;
        }

        if (!data) throw invalidBackup("Backup manifest is missing");
        if (entry.fileName.endsWith("/")) {
          if (
            entry.uncompressedSize !== 0 ||
            ![...expected.keys()].some((name) => name.startsWith(entry.fileName))
          ) {
            throw invalidBackup(`Archive contains an unexpected entry: ${entry.fileName}`);
          }
          continue;
        }
        const target = expected.get(entry.fileName);
        if (!target || seen.has(entry.fileName)) {
          throw invalidBackup(`Archive contains an unexpected entry: ${entry.fileName}`);
        }
        await writeProofEntry(zip, entry, target);
        createdObjectKeys.add(target.targetKey);
        seen.add(entry.fileName);
      }
      if (!data) throw invalidBackup("Backup manifest is missing");
      if (seen.size !== expected.size) {
        throw invalidBackup("Backup proof images are incomplete");
      }

      const oldProofs = (await getDb().select().from(proofAssets)) as StoredProof[];
      try {
        await replaceDatabase(data);
        databaseReplaced = true;
      } catch (error) {
        throw invalidBackup(
          error instanceof Error
            ? `Backup database rows are inconsistent: ${error.message}`
            : "Backup database rows are inconsistent"
        );
      }
      await removeStoredProofs(oldProofs);
      await seedDatabase();
      await reconcileSystem();
    } catch (error) {
      if (!databaseReplaced) {
        await Promise.allSettled(
          [...createdObjectKeys].map((key) => deleteObject(key))
        );
      }
      if (databaseReplaced) throw error;
      if (error instanceof AppError) throw error;
      throw invalidBackup(
        error instanceof Error ? error.message : "Backup restore failed"
      );
    } finally {
      if (zip.isOpen) zip.close();
    }
  });
}
