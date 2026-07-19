import fs from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { config } from "../config";
import * as schema from "./schema";

type Database = ReturnType<typeof drizzlePg<typeof schema>> | ReturnType<typeof drizzlePglite<typeof schema>>;

let database: Database | undefined;
let closeDatabase: (() => Promise<void>) | undefined;

export function collectRuntimeGarbage(): void {
  const runtime = globalThis as typeof globalThis & { gc?: () => void };
  runtime.gc?.();
}

export async function initializeDatabase(): Promise<Database> {
  if (database) return database;

  const migrationsFolder = path.resolve(process.cwd(), "drizzle");

  if (config.DATABASE_URL) {
    const pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000
    });
    const db = drizzlePg(pool, { schema });
    await migratePg(db, { migrationsFolder });
    database = db;
    closeDatabase = async () => pool.end();
  } else {
    await fs.mkdir(path.dirname(config.PGLITE_PATH), { recursive: true });
    const client = await PGlite.create({
      dataDir: config.PGLITE_PATH,
      initialMemory: config.PGLITE_INITIAL_MEMORY_MB * 1024 * 1024
    });
    collectRuntimeGarbage();
    const db = drizzlePglite(client, { schema });
    await migratePglite(db, { migrationsFolder });
    collectRuntimeGarbage();
    database = db;
    closeDatabase = async () => client.close();
  }

  return database;
}

export function getDb(): any {
  if (!database) throw new Error("Database has not been initialized");
  return database;
}

export async function shutdownDatabase(): Promise<void> {
  await closeDatabase?.();
  database = undefined;
  closeDatabase = undefined;
}
