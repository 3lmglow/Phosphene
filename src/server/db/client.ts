import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { config } from "../config";
import * as schema from "./schema";

type Database = LibSQLDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const BUSY_TIMEOUT_MS = 5000;

let database: Database | undefined;
let client: Client | undefined;

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
  if (config.SQLITE_PATH !== ":memory:") {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA synchronous = NORMAL");
  }

  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
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
