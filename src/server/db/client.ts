import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { config } from "../config";
import * as schema from "./schema";

let database: LibSQLDatabase<typeof schema> | undefined;
let client: Client | undefined;

export async function initializeDatabase(): Promise<LibSQLDatabase<typeof schema>> {
  if (database) return database;

  if (config.SQLITE_PATH !== ":memory:") {
    await fs.mkdir(path.dirname(config.SQLITE_PATH), { recursive: true });
  }

  client = createClient({
    url:
      config.SQLITE_PATH === ":memory:"
        ? ":memory:"
        : pathToFileURL(config.SQLITE_PATH).href
  });
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 5000");
  if (config.SQLITE_PATH !== ":memory:") {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA synchronous = NORMAL");
  }

  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  database = db;
  return database;
}

export function getDb(): LibSQLDatabase<typeof schema> {
  if (!database) throw new Error("Database has not been initialized");
  return database;
}

export async function shutdownDatabase(): Promise<void> {
  client?.close();
  database = undefined;
  client = undefined;
}
