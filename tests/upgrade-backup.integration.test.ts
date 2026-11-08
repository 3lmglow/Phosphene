import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { version } from "../package.json";
import { config } from "../src/server/config";
import { getUpgradeBackupResult, initializeDatabase, shutdownDatabase } from "../src/server/db/client";
import {
  backupBeforeUpgrade,
  encodeVersion,
  KEPT_UPGRADE_BACKUPS,
  recordDatabaseVersion,
  upgradeBackupDirectory
} from "../src/server/db/upgrade-backup";

let directory: string;
const clients: Client[] = [];

function open(file: string) {
  const client = createClient({ url: pathToFileURL(path.join(directory, file)).href });
  clients.push(client);
  return client;
}

async function existingDatabase(file: string) {
  const client = open(file);
  await client.execute("PRAGMA journal_mode = WAL");
  await migrate(drizzle(client), { migrationsFolder: path.resolve("drizzle") });
  // Left in the WAL on purpose: the copy must include pages that were not checkpointed yet.
  await client.execute("INSERT INTO app_settings (id, user_label) VALUES (1, 'Before upgrade')");
  return client;
}

async function backupNames(sqliteFile: string) {
  return (await fs.readdir(upgradeBackupDirectory(path.join(directory, sqliteFile))).catch(() => [])).sort();
}

beforeAll(async () => {
  // Clean at the start like the other suites: Windows can keep SQLite handles open until the worker exits.
  directory = path.resolve(".data/upgrade-backup-integration");
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
});

afterAll(async () => {
  for (const client of clients) client.close();
  await shutdownDatabase();
});

describe("database copy before an upgrade", () => {
  it("skips a brand-new database that has nothing to protect", async () => {
    const client = open("fresh.sqlite");
    expect(await backupBeforeUpgrade(client, path.join(directory, "fresh.sqlite"), "1.2.2")).toBeNull();
    expect(await backupNames("fresh.sqlite")).toEqual([]);
  });

  it("copies an existing database once per release, including rows still in the WAL", async () => {
    const sqlitePath = path.join(directory, "existing.sqlite");
    const client = await existingDatabase("existing.sqlite");

    const copy = await backupBeforeUpgrade(client, sqlitePath, "1.2.2", new Date("2026-11-08T08:00:00.000Z"));
    expect(copy).toBe(path.join(directory, "backups", "2026-11-08T08-00-00.000Z-before-v1.2.2.sqlite"));
    const saved = open(path.join("backups", path.basename(copy!)));
    const rows = await saved.execute("SELECT user_label FROM app_settings WHERE id = 1");
    expect(rows.rows[0].user_label).toBe("Before upgrade");

    await recordDatabaseVersion(client, "1.2.2");
    expect(Number((await client.execute("PRAGMA user_version")).rows[0].user_version)).toBe(encodeVersion("1.2.2"));
    expect(await backupBeforeUpgrade(client, sqlitePath, "1.2.2")).toBeNull();
    expect(await backupNames("existing.sqlite")).toHaveLength(1);
  });

  it(`keeps only the newest ${KEPT_UPGRADE_BACKUPS} copies`, async () => {
    const sqlitePath = path.join(directory, "rotating", "rotating.sqlite");
    await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
    const client = await existingDatabase(path.join("rotating", "rotating.sqlite"));
    for (let release = 1; release <= 5; release += 1) {
      const copy = await backupBeforeUpgrade(client, sqlitePath, `1.3.${release}`, new Date(Date.UTC(2026, 11, release)));
      expect(copy).not.toBeNull();
      await recordDatabaseVersion(client, `1.3.${release}`);
    }
    expect(await backupNames(path.join("rotating", "rotating.sqlite"))).toEqual([
      "2026-12-03T00-00-00.000Z-before-v1.3.3.sqlite",
      "2026-12-04T00-00-00.000Z-before-v1.3.4.sqlite",
      "2026-12-05T00-00-00.000Z-before-v1.3.5.sqlite"
    ]);
  });

  it("is wired into startup: a new database is only stamped, an older one is copied first", async () => {
    const sqlitePath = path.join(directory, "startup", "phosphene.sqlite");
    config.SQLITE_PATH = sqlitePath;
    await initializeDatabase();
    expect(getUpgradeBackupResult()).toBeNull();
    await shutdownDatabase();

    const older = open(path.join("startup", "phosphene.sqlite"));
    await older.execute(`PRAGMA user_version = ${encodeVersion("1.1.1")}`);
    older.close();

    await initializeDatabase();
    const result = getUpgradeBackupResult();
    expect(result && "path" in result && path.basename(result.path)).toMatch(new RegExp(`-before-v${version.replace(/\./g, "\\.")}\\.sqlite$`));
    await shutdownDatabase();

    const reopened = open(path.join("startup", "phosphene.sqlite"));
    expect(Number((await reopened.execute("PRAGMA user_version")).rows[0].user_version)).toBe(encodeVersion(version));
  });
});
