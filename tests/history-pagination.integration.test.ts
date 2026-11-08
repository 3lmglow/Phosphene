import { once } from "node:events";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/server/config";
import { getDb, initializeDatabase, shutdownDatabase } from "../src/server/db/client";
import { seedDatabase } from "../src/server/db/seed";
import { auditLogs, pointLedger } from "../src/server/db/schema";
import { handleMcp } from "../src/server/mcp";
import { queryHistory } from "../src/server/services/domain";

const DAY = 86_400_000;

// Rows dated after everything the app writes during the test, so they fill the first pages.
function futureInstant(days: number, milliseconds: number): Date {
  const at = new Date(Date.now() + days * DAY);
  at.setUTCMilliseconds(milliseconds);
  return at;
}

async function insertAuditRows(prefix: string, count: number, createdAt: Date): Promise<string[]> {
  const ids = Array.from({ length: count }, (_, index) => `${prefix}_${String(index).padStart(3, "0")}`);
  await getDb().insert(auditLogs).values(
    ids.map((id) => ({
      id,
      actor: "system" as const,
      action: "test.same_millisecond",
      entityType: "test",
      entityId: id,
      summary: `Row ${id}`,
      createdAt
    }))
  );
  return ids;
}

type HistoryPage = {
  next_cursor: string | null;
  has_more: boolean;
  audit?: Array<{ id: string }>;
  timeline?: Array<{ id: string }>;
};

describe.sequential("history pagination", () => {
  let server: Server;
  let base = "";

  beforeAll(async () => {
    const directory = path.resolve(".data/history-pagination-integration");
    await fs.mkdir(directory, { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.rm(path.join(directory, `test.sqlite${suffix}`), { force: true });
    }
    config.SQLITE_PATH = path.join(directory, "test.sqlite");
    await initializeDatabase();
    await seedDatabase();

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.all("/mcp", (request, response, next) => {
      handleMcp(request, response).catch(next);
    });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await shutdownDatabase();
  });

  it("reads every audit row that shares one millisecond across pages", async () => {
    const ids = await insertAuditRows("audit_same_ms", 51, futureInstant(365, 123));

    const first = (await queryHistory({ kind: "audit", limit: 50 })) as HistoryPage;
    expect(first.audit).toHaveLength(50);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = (await queryHistory({
      kind: "audit",
      limit: 50,
      cursor: first.next_cursor!
    })) as HistoryPage;
    const seen = [...first.audit!, ...second.audit!].map((row) => row.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((id) => ids.includes(id)).sort()).toEqual(ids);
    expect(ids).toContain(second.audit![0].id);
  });

  it("reads every timeline entry that shares one millisecond across pages", async () => {
    const createdAt = futureInstant(730, 456);
    const ids = Array.from({ length: 51 }, (_, index) => `points_same_ms_${String(index).padStart(3, "0")}`);
    await getDb().insert(pointLedger).values(
      ids.map((id) => ({
        id,
        type: "manual_bonus" as const,
        amount: 1,
        idempotencyKey: `history-pagination:${id}`,
        reason: "Same millisecond",
        createdAt
      }))
    );

    const first = (await queryHistory({ kind: "all", limit: 50 })) as HistoryPage;
    expect(first.timeline).toHaveLength(50);
    expect(first.has_more).toBe(true);

    const second = (await queryHistory({
      kind: "all",
      limit: 50,
      cursor: first.next_cursor!
    })) as HistoryPage;
    const seen = [...first.timeline!, ...second.timeline!].map((row) => row.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((id) => ids.includes(id)).sort()).toEqual(ids);
    expect(ids).toContain(second.timeline![0].id);
  });

  it("lets the AI page through history over MCP with next_cursor", async () => {
    const client = new Client({ name: "history-pagination-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const { tools } = await client.listTools();
      const historyTool = tools.find((tool) => tool.name === "query_history");
      expect(historyTool?.inputSchema.properties).toHaveProperty("cursor");
      expect(historyTool?.description).toMatch(/next_cursor/);

      // Three newer rows with distinct times make a page of two leave exactly one behind.
      const ids = [
        ...(await insertAuditRows("audit_mcp_c", 1, futureInstant(1100, 300))),
        ...(await insertAuditRows("audit_mcp_b", 1, futureInstant(1100, 200))),
        ...(await insertAuditRows("audit_mcp_a", 1, futureInstant(1100, 100)))
      ];
      const call = async (args: Record<string, unknown>) => {
        const response = await client.callTool({ name: "query_history", arguments: args });
        expect(response.isError).toBeFalsy();
        return (response.structuredContent as { result: HistoryPage }).result;
      };

      const first = await call({ kind: "audit", limit: 2 });
      expect(first.audit!.map((row) => row.id)).toEqual(ids.slice(0, 2));
      expect(first.has_more).toBe(true);

      const second = await call({ kind: "audit", limit: 2, cursor: first.next_cursor });
      expect(second.audit![0].id).toBe(ids[2]);

      const rejected = await client
        .callTool({ name: "query_history", arguments: { kind: "audit", cursor: "not a cursor" } })
        .then((response) => Boolean(response.isError), () => true);
      expect(rejected).toBe(true);
    } finally {
      await client.close();
    }
  });
});
