import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { createClient } from "@libsql/client";
import { ZipArchive } from "archiver";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPromise } from "yauzl";
import { config } from "../src/server/config";
import { getDb, initializeDatabase, shutdownDatabase } from "../src/server/db/client";
import { seedDatabase } from "../src/server/db/seed";
import { appSettings, taskSubmissions, tasks } from "../src/server/db/schema";
import { localDate } from "../src/server/lib/dates";
import { exportBackupToFile, restoreBackupFromFile } from "../src/server/services/backup";
import { createTask, manageTask, submitTask } from "../src/server/services/domain";
import { manageTaskSchema } from "../src/shared/schemas";

const HOUR = 3_600_000;
// 25 hours apart, so any instant falls on different calendar dates in the two zones.
const SUBMIT_ZONE = "Pacific/Pago_Pago";
const REVIEW_ZONE = "Pacific/Kiritimati";
const DEFAULT_ZONE = "Asia/Shanghai";

async function setTimezone(timezone: string): Promise<void> {
  await getDb().update(appSettings).set({ timezone }).where(eq(appSettings.id, 1));
}

async function createReviewedTask(key: string): Promise<string> {
  const created = await createTask({
    title: `Reviewed ${key}`,
    description: "",
    type: "challenge",
    difficulty: "easy",
    base_points: 3,
    verification_mode: "ai_review",
    proof_requirement: "text",
    recurrence: "once",
    daily_deadline_time: "23:59",
    deadline: new Date(Date.now() + 72 * HOUR).toISOString(),
    reveal_mode: "immediate",
    idempotency_key: `submission-date-task-${key}`
  });
  if (created.kind !== "task") throw new Error("Expected a one-time task");
  return created.task.id;
}

async function submit(taskId: string) {
  const submitted = await submitTask(taskId, "Done", [], "user");
  return assertSubmission(submitted.submission_id);
}

async function assertSubmission(id: string) {
  const row = await getDb().query.taskSubmissions.findFirst({ where: eq(taskSubmissions.id, id) });
  if (!row) throw new Error(`Submission ${id} is missing`);
  return row;
}

async function approve(taskId: string, key: string) {
  return (await manageTask(
    manageTaskSchema.parse({
      action: "review",
      task_id: taskId,
      decision: "approve",
      idempotency_key: `submission-date-approve-${key}`
    }),
    "AI"
  )) as { completion_date: string };
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

describe.sequential("completion date of reviewed submissions", () => {
  let directory = "";

  beforeAll(async () => {
    // Clean at the next start rather than in afterAll: Windows may keep native
    // SQLite handles open until the worker exits.
    directory = path.resolve(".data/submission-date-integration");
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(directory, { recursive: true });
    config.SQLITE_PATH = path.join(directory, "test.sqlite");
    await initializeDatabase();
    await seedDatabase();
  });

  afterAll(async () => {
    await shutdownDatabase();
  });

  it("keeps the local date of submission when the timezone changes before review", async () => {
    await setTimezone(SUBMIT_ZONE);
    const first = await createReviewedTask("first");
    const second = await createReviewedTask("second");
    const submissions = [await submit(first), await submit(second)];
    for (const submission of submissions) {
      expect(submission.submittedLocalDate).toBe(localDate(submission.submittedAt, SUBMIT_ZONE));
    }

    await setTimezone(REVIEW_ZONE);
    try {
      expect((await approve(first, "first")).completion_date).toBe(submissions[0].submittedLocalDate);
      expect((await approve(second, "second")).completion_date).toBe(submissions[1].submittedLocalDate);
      for (const [index, taskId] of [first, second].entries()) {
        expect(
          (await getDb().query.tasks.findFirst({ where: eq(tasks.id, taskId) }))?.completionDate
        ).toBe(submissions[index].submittedLocalDate);
      }
    } finally {
      await setTimezone(DEFAULT_ZONE);
    }
  });

  it("falls back to the current timezone for submissions saved before the date was recorded", async () => {
    const taskId = await createReviewedTask("legacy");
    const submission = await submit(taskId);
    await getDb()
      .update(taskSubmissions)
      .set({ submittedLocalDate: null })
      .where(eq(taskSubmissions.id, submission.id));

    await setTimezone(REVIEW_ZONE);
    try {
      expect((await approve(taskId, "legacy")).completion_date).toBe(
        localDate(submission.submittedAt, REVIEW_ZONE)
      );
    } finally {
      await setTimezone(DEFAULT_ZONE);
    }
  });

  it("restores a backup made before submissions recorded their local date", async () => {
    const taskId = await createReviewedTask("restored");
    const pending = await submit(taskId);
    const backupPath = path.join(directory, "backup.zip");
    const olderBackupPath = path.join(directory, "older-backup.zip");
    await exportBackupToFile(backupPath);
    const manifest = await readManifest(backupPath);
    expect(manifest.data.taskSubmissions.length).toBeGreaterThan(0);
    for (const row of manifest.data.taskSubmissions) delete row.submittedLocalDate;
    await writeManifestOnlyBackup(olderBackupPath, manifest);

    await restoreBackupFromFile(olderBackupPath);

    const restored = await assertSubmission(pending.id);
    expect(restored.status).toBe("pending");
    expect(restored.submittedLocalDate).toBeNull();
    expect((await approve(taskId, "restored")).completion_date).toBe(
      localDate(pending.submittedAt, DEFAULT_ZONE)
    );
  });
});

describe("submission date migration", () => {
  const workDirectory = path.resolve(".data/submission-date-migration");

  afterAll(async () => {
    await fs.rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
  });

  it("adds an empty local date to submissions that already exist", async () => {
    await fs.rm(workDirectory, { recursive: true, force: true });
    const folder = path.join(workDirectory, "migrations");
    await fs.mkdir(path.join(folder, "meta"), { recursive: true });
    const journal = JSON.parse(await fs.readFile("drizzle/meta/_journal.json", "utf8"));
    const last = journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0007_update_check");
    expect(last).toBeGreaterThan(-1);
    const entries = journal.entries.slice(0, last + 1);
    for (const entry of entries) {
      await fs.copyFile(`drizzle/${entry.tag}.sql`, path.join(folder, `${entry.tag}.sql`));
    }
    await fs.writeFile(path.join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));

    const client = createClient({ url: `file:${path.join(workDirectory, "upgrade.sqlite")}` });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      const db = drizzle(client);
      await migrate(db, { migrationsFolder: folder });
      await client.batch([
        `INSERT INTO tasks (id, title, type, difficulty, base_points, status, verification_mode, proof_requirement)
         VALUES ('task_old', 'Old task', 'challenge', 'easy', 3, 'submitted', 'ai_review', 'text')`,
        `INSERT INTO task_submissions (id, task_id, attempt, proof_text, status)
         VALUES ('submission_old', 'task_old', 1, 'Done', 'pending')`
      ], "write");

      await migrate(db, { migrationsFolder: path.resolve("drizzle") });

      const columns = await client.execute("PRAGMA table_info(task_submissions)");
      expect(columns.rows).toContainEqual(
        expect.objectContaining({ name: "submitted_local_date", notnull: 0, dflt_value: null })
      );
      const rows = await client.execute("SELECT id, status, submitted_local_date FROM task_submissions");
      expect(rows.rows).toEqual([
        expect.objectContaining({ id: "submission_old", status: "pending", submitted_local_date: null })
      ]);
    } finally {
      client.close();
    }
  });
});
