import { createHash, randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express, { type RequestHandler } from "express";
import { inArray, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openPromise } from "yauzl";
import { config } from "../src/server/config";
import { getDb, initializeDatabase, shutdownDatabase } from "../src/server/db/client";
import { seedDatabase } from "../src/server/db/seed";
import { proofAssets, taskSubmissions, tasks } from "../src/server/db/schema";
import router, { apiErrorHandler } from "../src/server/routes";
import {
  estimateBackupArchiveBytes,
  exportBackupToFile,
  getActiveBackupOperation
} from "../src/server/services/backup";

vi.mock("../src/server/services/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/server/services/auth")>();
  const pass: RequestHandler = (_request, _response, next) => next();
  return { ...original, requireUser: pass, requireCsrf: pass };
});

const MiB = 1024 * 1024;
const directory = path.resolve(".data/backup-export-integration");
const storageRoot = path.join(directory, "uploads");

const app = express();
app.use(router, apiErrorHandler);
const server = app.listen(0, "127.0.0.1");
let baseUrl = "";

async function writeObject(key: string, content: Buffer): Promise<void> {
  const filePath = path.join(storageRoot, ...key.split("/"));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

// Rows that point at the given objects; the export only checks sizes and hashes,
// so the bytes do not have to be real images.
async function insertProofs(
  prefix: string,
  originals: Buffer[],
  options: { reportedSize?: number } = {}
): Promise<void> {
  const taskId = `task_${prefix}`;
  const submissionId = `submission_${prefix}`;
  await getDb().insert(tasks).values({
    id: taskId,
    title: `Proof task ${prefix}`,
    type: "challenge",
    difficulty: "easy",
    basePoints: 1,
    status: "cancelled",
    verificationMode: "self",
    proofRequirement: "image",
    createdBy: "user"
  });
  await getDb().insert(taskSubmissions).values({ id: submissionId, taskId });
  for (const [index, original] of originals.entries()) {
    const id = `proof_${prefix}_${index}`;
    const objectKey = `proofs/${id}/original.webp`;
    const previewKey = `proofs/${id}/preview.webp`;
    await writeObject(objectKey, original);
    await writeObject(previewKey, original.subarray(0, Math.ceil(original.byteLength / 4)));
    await getDb().insert(proofAssets).values({
      id,
      submissionId,
      objectKey,
      previewKey,
      mimeType: "image/webp",
      sizeBytes: options.reportedSize ?? original.byteLength,
      sha256: createHash("sha256").update(original).digest("hex"),
      width: 100,
      height: 100
    });
  }
}

async function removeProofs(prefix: string): Promise<void> {
  await getDb().delete(proofAssets).where(like(proofAssets.id, `proof_${prefix}_%`));
  await getDb().delete(taskSubmissions).where(inArray(taskSubmissions.id, [`submission_${prefix}`]));
  await getDb().delete(tasks).where(inArray(tasks.id, [`task_${prefix}`]));
  const proofRoot = path.join(storageRoot, "proofs");
  for (const entry of await fs.readdir(proofRoot)) {
    if (entry.startsWith(`proof_${prefix}_`)) {
      await fs.rm(path.join(proofRoot, entry), { recursive: true, force: true });
    }
  }
}

type CreateReadStream = typeof fsSync.createReadStream;

// The backup service and archiver import createReadStream from node:fs by name;
// syncBuiltinESMExports() makes those imports see the replacement too.
function replaceCreateReadStream(
  replacement: (original: CreateReadStream, ...args: Parameters<CreateReadStream>) => fsSync.ReadStream
): () => void {
  const original = fsSync.createReadStream;
  fsSync.createReadStream = ((...args: Parameters<CreateReadStream>) =>
    replacement(original, ...args)) as CreateReadStream;
  syncBuiltinESMExports();
  return () => {
    fsSync.createReadStream = original;
    syncBuiltinESMExports();
  };
}

// Records every file stream opened under private storage and how many were open at once.
function trackStorageReads() {
  const tracker = { opened: [] as fsSync.ReadStream[], mostOpenAtOnce: 0, restore: () => {} };
  let open = 0;
  tracker.restore = replaceCreateReadStream((original, ...args) => {
    const stream = original(...args);
    if (String(args[0]).startsWith(storageRoot)) {
      tracker.opened.push(stream);
      open += 1;
      tracker.mostOpenAtOnce = Math.max(tracker.mostOpenAtOnce, open);
      stream.once("close", () => {
        open -= 1;
      });
    }
    return stream;
  });
  return tracker;
}

async function readArchive(filePath: string) {
  const zip = await openPromise(filePath, {
    autoClose: true,
    lazyEntries: true,
    validateEntrySizes: true
  });
  const entries: Array<{ name: string; size: number; sha256: string }> = [];
  let manifest: Record<string, any> | null = null;
  try {
    for await (const entry of zip.eachEntry()) {
      const chunks: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(entry)) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks);
      if (!manifest) manifest = JSON.parse(content.toString("utf8"));
      entries.push({
        name: entry.fileName,
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex")
      });
    }
  } finally {
    if (zip.isOpen) zip.close();
  }
  return { manifest: manifest!, entries };
}

describe.sequential("backup export", () => {
  beforeAll(async () => {
    // Clean at the next start rather than in afterAll: Windows may keep native
    // SQLite handles open until the worker exits.
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(storageRoot, { recursive: true });
    config.SQLITE_PATH = path.join(directory, "test.sqlite");
    config.LOCAL_STORAGE_PATH = storageRoot;
    config.BACKUP_TEMP_PATH = path.join(directory, "tmp");
    await initializeDatabase();
    await seedDatabase();
    await getDb().insert(tasks).values(
      Array.from({ length: 120 }, (_, index) => ({
        id: `task_bulk_${index}`,
        title: `Bulk task ${index}`,
        description: `Bulk description ${index}`,
        type: "challenge" as const,
        difficulty: "easy" as const,
        basePoints: 1,
        status: "cancelled" as const,
        verificationMode: "self" as const,
        proofRequirement: "none" as const,
        createdBy: "user" as const
      }))
    );
    // Random bytes do not compress, so the download stays far bigger than any
    // socket buffer and the client really does leave halfway through.
    await insertProofs("stream", [randomBytes(8 * MiB), randomBytes(8 * MiB)]);
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await shutdownDatabase();
  });

  it("recovers when the client disconnects in the middle of a download", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const reads = trackStorageReads();
    try {
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/backup/export`, { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/zip");
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      expect(getActiveBackupOperation()).toBe("export");
      controller.abort();

      await vi.waitFor(() => expect(getActiveBackupOperation()).toBeNull(), {
        timeout: 5_000,
        interval: 20
      });
      // Give a rejection nobody handles time to surface.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
      // The proof file being read when the client left is closed again, and files
      // were opened one after another rather than all at once.
      await vi.waitFor(() => {
        expect(reads.opened.length).toBeGreaterThan(0);
        expect(reads.opened.filter((stream) => !stream.closed)).toHaveLength(0);
      });
      expect(reads.mostOpenAtOnce).toBeLessThanOrEqual(2);
    } finally {
      reads.restore();
      process.off("unhandledRejection", onUnhandled);
    }

    const response = await fetch(`${baseUrl}/backup/export`);
    expect(response.status).toBe(200);
    const archivePath = path.join(directory, "after-abort.zip");
    await fs.writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
    const { manifest, entries } = await readArchive(archivePath);
    expect(entries[0].name).toBe("phosphene-backup.json");
    expect(manifest.data.tasks.length).toBeGreaterThanOrEqual(121);
    expect(entries.slice(1).map(({ name }) => name).sort()).toEqual(Object.keys(manifest.objects).sort());
    for (const { name, size, sha256 } of entries.slice(1)) {
      expect({ size, sha256 }).toEqual({
        size: manifest.objects[name].sizeBytes,
        sha256: manifest.objects[name].sha256
      });
    }
    expect(getActiveBackupOperation()).toBeNull();
  }, 30_000);

  it("estimates at least the size of the archive it writes", async () => {
    const archivePath = path.join(directory, "estimate.zip");
    await exportBackupToFile(archivePath);
    const { size } = await fs.stat(archivePath);
    const { entries } = await readArchive(archivePath);
    const [manifestEntry, ...objectEntries] = entries;
    const estimate = estimateBackupArchiveBytes(
      manifestEntry.size,
      Object.fromEntries(objectEntries.map(({ name, size }) => [name, { sizeBytes: size }]))
    );
    expect(size).toBeLessThanOrEqual(estimate);
    // The stored proof objects make up nearly all of this archive, and those are
    // counted to within a few bytes per entry.
    expect(estimate).toBeLessThan(size * 1.01);
  });

  it("refuses before sending anything when restore would reject the ZIP", async () => {
    const objectLimit = 64 * MiB;
    // Twenty proofs whose two objects are each reported at the per-object limit add up
    // to 2.5 GiB, more than a restore accepts, without writing gigabytes to disk.
    await insertProofs(
      "oversized",
      Array.from({ length: 20 }, () => randomBytes(64)),
      { reportedSize: objectLimit }
    );
    const realStat = fs.stat;
    vi.spyOn(fs, "stat").mockImplementation((async (target: fsSync.PathLike, options?: any) => {
      const stats = await realStat(target, options);
      if (String(target).includes(`${path.sep}proof_oversized_`)) stats.size = objectLimit;
      return stats;
    }) as typeof fs.stat);
    try {
      const response = await fetch(`${baseUrl}/backup/export`);
      expect(response.status).toBe(413);
      expect(response.headers.get("content-type")).toMatch(/^application\/json/);
      expect(response.headers.get("content-disposition")).toBeNull();
      const body = await response.json();
      expect(body.error.code).toBe("backup_too_large");
      expect(body.error.message).toMatch(/\/data volume snapshot/);
      expect(getActiveBackupOperation()).toBeNull();

      const archivePath = path.join(directory, "oversized.zip");
      await expect(exportBackupToFile(archivePath)).rejects.toMatchObject({
        status: 413,
        code: "backup_too_large"
      });
      await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(getActiveBackupOperation()).toBeNull();
    } finally {
      vi.restoreAllMocks();
      await removeProofs("oversized");
    }

    // Once the instance fits again, exporting works as before.
    const response = await fetch(`${baseUrl}/backup/export`);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(20 * MiB);
  }, 30_000);

  it("fails cleanly when a proof file cannot be read during the export", async () => {
    const target = path.join(storageRoot, "proofs", "proof_stream_1", "original.webp");
    let opens = 0;
    // The first open hashes the file; the second is the export reading it into the ZIP.
    const restore = replaceCreateReadStream((original, ...args) =>
      String(args[0]) === target && ++opens === 2
        ? original(`${target}.missing`)
        : original(...args)
    );
    try {
      const archivePath = path.join(directory, "unreadable.zip");
      await expect(exportBackupToFile(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(opens).toBe(2);
      expect(getActiveBackupOperation()).toBeNull();
    } finally {
      restore();
    }
  });

  it("never deletes a file that already exists at the export path", async () => {
    const existingPath = path.join(directory, "existing.zip");
    await fs.writeFile(existingPath, "keep me");
    await expect(exportBackupToFile(existingPath)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(existingPath, "utf8")).toBe("keep me");
    expect(getActiveBackupOperation()).toBeNull();
  });
});
