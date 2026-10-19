import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterAll, expect, it } from "vitest";

const workDirectory = path.resolve(".data/migration-upgrade");

async function migrationsUpTo(tag: string) {
  const journal = JSON.parse(await fs.readFile("drizzle/meta/_journal.json", "utf8"));
  const last = journal.entries.findIndex((entry: { tag: string }) => entry.tag === tag);
  expect(last).toBeGreaterThan(-1);
  const folder = path.join(workDirectory, "migrations");
  await fs.mkdir(path.join(folder, "meta"), { recursive: true });
  const entries = journal.entries.slice(0, last + 1);
  for (const entry of entries) await fs.copyFile(`drizzle/${entry.tag}.sql`, path.join(folder, `${entry.tag}.sql`));
  await fs.writeFile(path.join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return folder;
}

afterAll(async () => {
  await fs.rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
});

it("keeps events, Webhook deliveries and event numbering when upgrading to task.expired", async () => {
  await fs.rm(workDirectory, { recursive: true, force: true });
  await fs.mkdir(workDirectory, { recursive: true });
  const client = createClient({ url: `file:${path.join(workDirectory, "upgrade.sqlite")}` });
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo("0005_oauth_connectors") });
    await client.batch([
      `INSERT INTO webhook_config (id, enabled, url, event_types, signing_secret)
       VALUES (1, 1, 'https://receiver.example/hook', '["task.submitted","task.completed"]', 'secret')`,
      `INSERT INTO domain_events (sequence, id, type, aggregate_type, aggregate_id, actor, payload, dedupe_key)
       VALUES (41, 'event_old', 'task.completed', 'task', 'task_old', 'system', '{}', 'task.completed:task_old')`,
      `INSERT INTO webhook_deliveries (id, event_id, status, attempt_count) VALUES ('delivery_old', 'event_old', 'delivered', 1)`
    ], "write");

    await migrate(db, { migrationsFolder: path.resolve("drizzle") });

    const deliveries = await client.execute("SELECT id, status FROM webhook_deliveries");
    expect(deliveries.rows).toEqual([expect.objectContaining({ id: "delivery_old", status: "delivered" })]);
    const config = await client.execute("SELECT event_types FROM webhook_config WHERE id = 1");
    expect(JSON.parse(String(config.rows[0].event_types))).toEqual(["task.submitted", "task.completed", "task.expired"]);
    await client.execute(
      `INSERT INTO domain_events (id, type, aggregate_type, aggregate_id, actor, payload, dedupe_key)
       VALUES ('event_new', 'task.expired', 'task', 'task_new', 'system', '{}', 'task.expired:task_new')`
    );
    const next = await client.execute("SELECT sequence FROM domain_events WHERE id = 'event_new'");
    expect(Number(next.rows[0].sequence)).toBe(42);
    const integrity = await client.execute("PRAGMA foreign_key_check");
    expect(integrity.rows).toEqual([]);

    await client.execute("INSERT INTO webhook_deliveries (id, event_id) VALUES ('delivery_new', 'event_new')");
    await client.execute("DELETE FROM domain_events WHERE id = 'event_new'");
    const cascaded = await client.execute("SELECT id FROM webhook_deliveries WHERE id = 'delivery_new'");
    expect(cascaded.rows).toEqual([]);
  } finally {
    client.close();
  }
});
