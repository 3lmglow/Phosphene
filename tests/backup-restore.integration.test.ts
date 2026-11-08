import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { ZipArchive } from "archiver";
import { asc, count, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openPromise } from "yauzl";
import { config } from "../src/server/config";
import { getDb, initializeDatabase, shutdownDatabase } from "../src/server/db/client";
import { seedDatabase } from "../src/server/db/seed";
import {
  auditLogs,
  domainEvents,
  pointLedger,
  tasks,
  webhookDeliveries
} from "../src/server/db/schema";
import { exportBackupToFile, restoreBackupFromFile } from "../src/server/services/backup";
import { getOverview, reconcileSystem } from "../src/server/services/domain";

// Each count is past the row limit a single multi-row INSERT can carry for that table
// (32,766 bound parameters divided by the table's column count).
const BULK = {
  tasks: 1_500,
  auditLogs: 5_000,
  pointLedger: 4_000,
  domainEvents: 3_500,
  webhookDeliveries: 2_500
};
const SECRET_MARKER = "do-not-echo-this-row-value";
const base = Date.UTC(2026, 0, 1);
const pad = (index: number) => String(index).padStart(5, "0");

async function insertInChunks(table: any, rows: Record<string, unknown>[]): Promise<void> {
  for (let start = 0; start < rows.length; start += 250) {
    await getDb().insert(table).values(rows.slice(start, start + 250));
  }
}

async function seedBulkRows(): Promise<void> {
  await insertInChunks(
    tasks,
    Array.from({ length: BULK.tasks }, (_, index) => ({
      id: `task_bulk_${pad(index)}`,
      title: `Bulk task ${index}`,
      description: `Bulk description ${index}`,
      type: "challenge",
      difficulty: "easy",
      basePoints: 1 + (index % 5),
      status: "cancelled",
      verificationMode: "self",
      proofRequirement: "none",
      createdBy: "user",
      failureReason: index % 2 ? null : `Cancelled bulk task ${index}`,
      createdAt: new Date(base + index * 1_000),
      updatedAt: new Date(base + index * 1_000)
    }))
  );
  await insertInChunks(
    auditLogs,
    Array.from({ length: BULK.auditLogs }, (_, index) => ({
      id: `audit_bulk_${pad(index)}`,
      actor: "system",
      action: "bulk.seeded",
      entityType: "task",
      entityId: `task_bulk_${pad(index % BULK.tasks)}`,
      summary: `Bulk audit ${index}`,
      metadata: { index },
      createdAt: new Date(base + index * 1_000)
    }))
  );
  await insertInChunks(
    pointLedger,
    Array.from({ length: BULK.pointLedger }, (_, index) => ({
      id: `ledger_bulk_${pad(index)}`,
      type: "manual_bonus",
      amount: 1 + (index % 3),
      idempotencyKey: `bulk-ledger-${index}`,
      reason: `Bulk bonus ${index}`,
      createdAt: new Date(base + index * 1_000)
    }))
  );
  await insertInChunks(
    domainEvents,
    Array.from({ length: BULK.domainEvents }, (_, index) => ({
      id: `event_bulk_${pad(index)}`,
      type: "notification.test",
      aggregateType: "system",
      aggregateId: "bulk",
      actor: "system",
      payload: { index },
      dedupeKey: `bulk-event-${index}`,
      createdAt: new Date(base + index * 1_000)
    }))
  );
  await insertInChunks(
    webhookDeliveries,
    Array.from({ length: BULK.webhookDeliveries }, (_, index) => ({
      id: `delivery_bulk_${pad(index)}`,
      eventId: `event_bulk_${pad(index)}`,
      status: "delivered",
      attemptCount: 1,
      lastStatusCode: 204,
      deliveredAt: new Date(base + index * 1_000),
      createdAt: new Date(base + index * 1_000),
      updatedAt: new Date(base + index * 1_000)
    }))
  );
}

async function rowCounts() {
  const db = getDb();
  const total = async (table: any) => (await db.select({ value: count() }).from(table))[0].value;
  return {
    tasks: await total(tasks),
    auditLogs: await total(auditLogs),
    pointLedger: await total(pointLedger),
    domainEvents: await total(domainEvents),
    webhookDeliveries: await total(webhookDeliveries)
  };
}

async function spotCheckRows() {
  const db = getDb();
  return {
    tasks: await db.query.tasks.findMany({
      where: (table, { inArray }) =>
        inArray(table.id, ["task_bulk_00000", "task_bulk_00750", `task_bulk_${pad(BULK.tasks - 1)}`]),
      orderBy: asc(tasks.id)
    }),
    audit: await db.query.auditLogs.findFirst({
      where: eq(auditLogs.id, `audit_bulk_${pad(BULK.auditLogs - 1)}`)
    }),
    ledger: await db.query.pointLedger.findFirst({
      where: eq(pointLedger.id, `ledger_bulk_${pad(BULK.pointLedger - 1)}`)
    }),
    events: await db.select().from(domainEvents).orderBy(asc(domainEvents.sequence)),
    delivery: await db.query.webhookDeliveries.findFirst({
      where: eq(webhookDeliveries.id, `delivery_bulk_${pad(BULK.webhookDeliveries - 1)}`)
    }),
    balance: (await getOverview()).statistics.balance
  };
}

async function readManifest(filePath: string): Promise<Record<string, any>> {
  const zip = await openPromise(filePath, { autoClose: true, lazyEntries: true });
  try {
    for await (const entry of zip.eachEntry()) {
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

async function writeManifestOnlyBackup(filePath: string, manifest: Record<string, any>): Promise<void> {
  const output = createWriteStream(filePath, { flags: "wx" });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.pipe(output);
  const done = Promise.all([finished(archive), finished(output)]);
  archive.append(JSON.stringify(manifest), { name: "phosphene-backup.json" });
  await archive.finalize();
  await done;
}

describe.sequential("backup restore at scale", () => {
  let directory = "";
  let backupPath = "";

  beforeAll(async () => {
    // Clean at the next start rather than in afterAll: Windows may keep native
    // SQLite handles open until the worker exits.
    directory = path.resolve(".data/backup-restore-integration");
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(directory, { recursive: true });
    config.SQLITE_PATH = path.join(directory, "test.sqlite");
    backupPath = path.join(directory, "large-backup.zip");
    await initializeDatabase();
    await seedDatabase();
    await seedBulkRows();
    await reconcileSystem();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await shutdownDatabase();
  });

  it("restores tables larger than one SQLite statement can insert", async () => {
    const countsBefore = await rowCounts();
    expect(countsBefore.tasks).toBeGreaterThanOrEqual(BULK.tasks);
    expect(countsBefore.auditLogs).toBeGreaterThanOrEqual(BULK.auditLogs);
    const rowsBefore = await spotCheckRows();
    expect(rowsBefore.tasks).toHaveLength(3);
    expect(rowsBefore.balance).toBeGreaterThan(0);

    await exportBackupToFile(backupPath);
    const db = getDb();
    await db.delete(webhookDeliveries);
    await db.delete(domainEvents);
    await db.delete(pointLedger);
    await db.delete(auditLogs);
    await db.delete(tasks);
    expect((await rowCounts()).tasks).toBe(0);

    await restoreBackupFromFile(backupPath);

    // The restore itself appends one backup.restored audit entry.
    expect(await rowCounts()).toEqual({ ...countsBefore, auditLogs: countsBefore.auditLogs + 1 });
    expect(await spotCheckRows()).toEqual(rowsBefore);
    expect(
      await db.query.auditLogs.findFirst({ where: eq(auditLogs.action, "backup.restored") })
    ).toBeDefined();
  }, 60_000);

  it("rolls back a failed restore without echoing SQL or row values", async () => {
    const manifest = await readManifest(backupPath);
    // Dropping tasks makes a partial restore visible; the dangling ledger row sits
    // after several full batches so the failure happens mid-way through the inserts.
    manifest.data.tasks = manifest.data.tasks.slice(100);
    manifest.data.pointLedger.push({
      id: "ledger_dangling",
      type: "manual_bonus",
      amount: 1,
      taskId: "task_missing",
      idempotencyKey: "bulk-ledger-dangling",
      reason: SECRET_MARKER,
      createdAt: new Date(base).toISOString()
    });
    const badPath = path.join(directory, "dangling-backup.zip");
    await fs.rm(badPath, { force: true });
    await writeManifestOnlyBackup(badPath, manifest);

    const countsBefore = await rowCounts();
    const rowsBefore = await spotCheckRows();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const error = await restoreBackupFromFile(badPath).then(
      () => null,
      (reason: unknown) => reason
    );
    expect(error).toMatchObject({ status: 400, code: "invalid_backup" });
    const message = (error as Error).message;
    expect(message.length).toBeLessThan(200);
    expect(message).not.toContain(SECRET_MARKER);
    expect(message).not.toMatch(/insert|params|ledger_dangling/i);

    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain("pointLedger");
    expect(logged).toContain("SQLITE_CONSTRAINT_FOREIGNKEY");
    expect(logged).not.toContain(SECRET_MARKER);
    expect(logged).not.toMatch(/insert into/i);

    expect(await rowCounts()).toEqual(countsBefore);
    expect(await spotCheckRows()).toEqual(rowsBefore);
  });
});
