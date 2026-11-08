import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { version } from "../../../package.json";
import { config } from "../config";
import * as schema from "./schema";
import { backupBeforeUpgrade, recordDatabaseVersion } from "./upgrade-backup";

type Database = LibSQLDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type UpgradeBackupResult = { path: string } | { error: unknown } | null;

const BUSY_TIMEOUT_MS = 5000;

let database: Database | undefined;
let client: Client | undefined;
let upgradeBackup: UpgradeBackupResult = null;

/** What happened to the pre-upgrade copy during the last initializeDatabase, for the startup log. */
export function getUpgradeBackupResult(): UpgradeBackupResult {
  return upgradeBackup;
}

export async function initializeDatabase(): Promise<Database> {
  if (database) return database;

  if (config.SQLITE_PATH !== ":memory:") {
    await fs.mkdir(path.dirname(config.SQLITE_PATH), { recursive: true });
  }

  client = createClient({
    url:
      config.SQLITE_PATH === ":memory:"
        ? ":memory:"
        : pathToFileURL(config.SQLITE_PATH).href,
    timeout: BUSY_TIMEOUT_MS
  });
  await client.execute("PRAGMA foreign_keys = ON");
  upgradeBackup = null;
  if (config.SQLITE_PATH !== ":memory:") {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA synchronous = NORMAL");
    // A failed copy (for example a full disk) is reported but does not keep the instance offline.
    try {
      const copy = await backupBeforeUpgrade(client, config.SQLITE_PATH, version);
      if (copy) upgradeBackup = { path: copy };
    } catch (error) {
      upgradeBackup = { error };
    }
  }

  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  if (config.SQLITE_PATH !== ":memory:") await recordDatabaseVersion(client, version);
  database = db;
  return database;
}

export function getDb(): Database {
  if (!database) throw new Error("Database has not been initialized");
  return database;
}

const transactionScope = new AsyncLocalStorage<true>();
let transactionQueue: Promise<unknown> = Promise.resolve();

export function runTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  if (transactionScope.getStore()) {
    return Promise.reject(
      new Error("runTransaction cannot be nested; pass the open transaction instead")
    );
  }
  const run = transactionQueue.then(() =>
    transactionScope.run(true, () => getDb().transaction(work))
  );
  transactionQueue = run.catch(() => undefined);
  return run;
}

export async function shutdownDatabase(): Promise<void> {
  await transactionQueue;
  client?.close();
  database = undefined;
  client = undefined;
}
