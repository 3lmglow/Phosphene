import fs from "node:fs/promises";
import path from "node:path";
import type { Client } from "@libsql/client";

export const KEPT_UPGRADE_BACKUPS = 3;
// The timestamp leads the name so that sorting names also sorts the copies by age.
const UPGRADE_BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-before-v.+\.sqlite$/;

// PRAGMA user_version is a free integer in the SQLite header. It travels with the file and with
// volume snapshots, so it records which release last opened this database.
export function encodeVersion(version: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Unsupported application version ${version}`);
  return Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3]);
}

export function upgradeBackupDirectory(sqlitePath: string): string {
  return path.join(path.dirname(sqlitePath), "backups");
}

async function pruneUpgradeBackups(directory: string): Promise<void> {
  const copies = (await fs.readdir(directory)).filter((name) => UPGRADE_BACKUP_NAME.test(name)).sort();
  await Promise.all(
    copies
      .slice(0, Math.max(0, copies.length - KEPT_UPGRADE_BACKUPS))
      .map((name) => fs.rm(path.join(directory, name), { force: true }))
  );
}

/**
 * Copies an existing database before a different release migrates it. Returns the copy's path,
 * or null when nothing needed protecting: a brand-new database, or the same release starting again.
 */
export async function backupBeforeUpgrade(
  client: Client,
  sqlitePath: string,
  version: string,
  now = new Date()
): Promise<string | null> {
  const recorded = Number((await client.execute("PRAGMA user_version")).rows[0]?.user_version ?? 0);
  if (recorded === encodeVersion(version)) return null;
  const existing = await client.execute(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
  );
  if (!existing.rows.length) return null;

  const directory = upgradeBackupDirectory(sqlitePath);
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, `${now.toISOString().replace(/:/g, "-")}-before-v${version}.sqlite`);
  try {
    // VACUUM INTO writes a consistent, self-contained copy that includes pages still in the WAL.
    await client.execute({ sql: "VACUUM INTO ?", args: [target] });
  } catch (error) {
    await fs.rm(target, { force: true });
    throw error;
  }
  await pruneUpgradeBackups(directory);
  return target;
}

export async function recordDatabaseVersion(client: Client, version: string): Promise<void> {
  // PRAGMA values cannot be bound; encodeVersion only ever returns an integer.
  await client.execute(`PRAGMA user_version = ${encodeVersion(version)}`);
}
