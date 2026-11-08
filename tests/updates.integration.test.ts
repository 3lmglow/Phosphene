import fs from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { version } from "../package.json";
import { config } from "../src/server/config";
import { getDb, initializeDatabase, shutdownDatabase } from "../src/server/db/client";
import { appSettings, auditLogs } from "../src/server/db/schema";
import { seedDatabase } from "../src/server/db/seed";
import router, { apiErrorHandler } from "../src/server/routes";
import {
  fetchLatestRelease,
  isNewerVersion,
  parseVersion,
  resetUpdateStateForTests
} from "../src/server/services/updates";

vi.mock("../src/server/services/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/server/services/auth")>();
  const pass: RequestHandler = (_request, _response, next) => next();
  return { ...original, requireUser: pass, requireCsrf: pass };
});

const realFetch = globalThis.fetch;
let server: ReturnType<typeof express.application.listen>;
let baseUrl: string;

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: "v9.9.9",
    name: "Phosphene v9.9.9 · 安全更新",
    html_url: "https://github.com/3lmglow/Phosphene/releases/tag/v9.9.9",
    published_at: "2026-11-10T08:00:00Z",
    draft: false,
    prerelease: false,
    ...overrides
  };
}

function github(body: unknown, init: ResponseInit = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200, ...init })) as unknown as typeof fetch;
}

// Only GitHub is faked; requests to the test server still go through the real fetch.
function stubGitHub(body: unknown, init: ResponseInit = {}) {
  const fake = github(body, init);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, options?: RequestInit) =>
    String(input).startsWith("https://api.github.com/") ? fake(input, options) : realFetch(input, options)
  );
  return fake;
}

async function api(pathname: string, method = "GET", body?: object) {
  const response = await realFetch(`${baseUrl}/api${pathname}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  const directory = path.resolve(".data/updates-integration");
  await fs.mkdir(directory, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) await fs.rm(path.join(directory, `test.sqlite${suffix}`), { force: true });
  config.SQLITE_PATH = path.join(directory, "test.sqlite");
  await initializeDatabase();
  await seedDatabase();
  const app = express();
  app.use("/api", express.json(), router, apiErrorHandler);
  server = app.listen(0, "127.0.0.1");
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  resetUpdateStateForTests();
  await getDb().update(appSettings).set({ updateCheckEnabled: true }).where(eq(appSettings.id, 1));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
  await shutdownDatabase();
});

describe("release versions", () => {
  it("compares major, minor and patch numbers", () => {
    expect(parseVersion("v1.2.10")).toEqual([1, 2, 10]);
    expect(parseVersion("1.2")).toBeNull();
    expect(isNewerVersion("1.2.10", "1.2.9")).toBe(true);
    expect(isNewerVersion("v1.10.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("1.2.1", "1.2.1")).toBe(false);
    expect(isNewerVersion("1.2.0", "1.2.1")).toBe(false);
    expect(isNewerVersion("nightly", "1.2.1")).toBe(false);
  });
});

describe("reading the latest release", () => {
  it("returns the version, title and release page", async () => {
    const fake = github(release());
    expect(await fetchLatestRelease(fake)).toEqual({
      version: "9.9.9",
      name: "Phosphene v9.9.9 · 安全更新",
      url: "https://github.com/3lmglow/Phosphene/releases/tag/v9.9.9",
      published_at: "2026-11-10T08:00:00Z"
    });
    const [url, init] = (fake as any).mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/3lmglow/Phosphene/releases/latest");
    expect(init.headers["User-Agent"]).toBe(`Phosphene/${version}`);
  });

  it.each([
    ["a prerelease", release({ prerelease: true })],
    ["a tag that is not a version", release({ tag_name: "nightly" })],
    ["a page outside the upstream repository", release({ html_url: "https://example.com/releases/v9.9.9" })]
  ])("rejects %s", async (_label, body) => {
    await expect(fetchLatestRelease(github(body))).rejects.toThrow();
  });

  it("rejects failed and oversized responses", async () => {
    await expect(fetchLatestRelease(github({ message: "rate limited" }, { status: 403 }))).rejects.toThrow("HTTP 403");
    const huge = vi.fn(async () => new Response("x".repeat(600 * 1024))) as unknown as typeof fetch;
    await expect(fetchLatestRelease(huge)).rejects.toThrow("too large");
  });
});

describe("update status API", () => {
  it("reports the running version before the first check", async () => {
    const { status, body } = await api("/updates");
    expect(status).toBe(200);
    expect(body.data).toEqual({
      enabled: true,
      current_version: version,
      latest: null,
      update_available: false,
      checked_at: null,
      check_failed: false
    });
  });

  it("turning the check on looks for a release and shows a newer one", async () => {
    const fake = stubGitHub(release());
    const { body } = await api("/updates", "PUT", { enabled: true });
    expect(fake).toHaveBeenCalledTimes(1);
    expect(body.data).toMatchObject({
      enabled: true,
      update_available: true,
      latest: { version: "9.9.9", url: "https://github.com/3lmglow/Phosphene/releases/tag/v9.9.9" },
      check_failed: false
    });
    expect(body.data.checked_at).toEqual(expect.any(String));
  });

  it("does not offer the release that is already running", async () => {
    stubGitHub(release({ tag_name: `v${version}`, html_url: `https://github.com/3lmglow/Phosphene/releases/tag/v${version}` }));
    const { body } = await api("/updates", "PUT", { enabled: true });
    expect(body.data).toMatchObject({ update_available: false, latest: { version } });
  });

  it("reports a failed check without inventing a release", async () => {
    stubGitHub({ message: "rate limited" }, { status: 403 });
    const { body } = await api("/updates", "PUT", { enabled: true });
    expect(body.data).toMatchObject({ update_available: false, latest: null, checked_at: null, check_failed: true });
  });

  it("turning the check off stops contacting GitHub, hides results and is audited", async () => {
    stubGitHub(release());
    await api("/updates", "PUT", { enabled: true });
    const fake = stubGitHub(release());
    const { body } = await api("/updates", "PUT", { enabled: false });
    expect(fake).not.toHaveBeenCalled();
    expect(body.data).toMatchObject({ enabled: false, update_available: false, latest: null });
    const [settings] = await getDb().select().from(appSettings);
    expect(settings.updateCheckEnabled).toBe(false);
    const audits = await getDb().select().from(auditLogs).where(eq(auditLogs.action, "settings.update_check"));
    expect(audits.at(-1)?.metadata).toEqual({ enabled: false });
  });

  it("rejects a malformed switch value", async () => {
    const { status } = await api("/updates", "PUT", { enabled: "yes" });
    expect(status).toBe(400);
  });
});
