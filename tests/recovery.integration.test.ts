import fs from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import cookieParser from "cookie-parser";
import express from "express";
import argon2 from "argon2";
import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/server/config";
import { getDb, initializeDatabase, shutdownDatabase } from "../src/server/db/client";
import { seedDatabase } from "../src/server/db/seed";
import { aiTokens, appSettings, auditLogs, sessions, userAccount } from "../src/server/db/schema";
import { changePassword, login, setupApplication } from "../src/server/services/auth";
import { getRecoveryStatus, resetPasswordWithRecovery, saveRecoverySettings } from "../src/server/services/recovery";
import { recoveryQuestionSchema } from "../src/shared/recovery";
import router, { apiErrorHandler } from "../src/server/routes";

const password = "old-password-123";
const nextPassword = "new-password-456";
const recovery = { question: "我的生日？", answer: "0101" };
const response = () => ({ cookie: vi.fn() }) as any;
let directory: string;
let server: ReturnType<typeof express.application.listen>;
let baseUrl: string;

beforeAll(async () => {
  // Like the domain suite, clean the dedicated test databases at the next start:
  // Windows may retain native SQLite statement handles until the worker exits.
  directory = path.resolve(".data/recovery-integration");
  await fs.mkdir(directory, { recursive: true });
  for (const file of ["test.sqlite", "legacy.sqlite"]) {
    for (const suffix of ["", "-wal", "-shm"]) await fs.rm(path.join(directory, `${file}${suffix}`), { force: true });
  }
  config.SQLITE_PATH = path.join(directory, "test.sqlite");
  await initializeDatabase();
  await seedDatabase();
  const app = express();
  app.use(cookieParser(), express.json(), router, apiErrorHandler);
  server = app.listen(0, "127.0.0.1");
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  vi.restoreAllMocks();
  const db = getDb();
  await db.delete(sessions);
  await db.delete(userAccount);
  await db.delete(aiTokens);
  await db.update(appSettings).set({ initialized: false }).where(eq(appSettings.id, 1));
});
afterAll(async () => {
  const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
  await shutdownDatabase();
});

async function setup(withRecovery = true) {
  return setupApplication({ setup_token: "", password, timezone: "Asia/Shanghai", user_label: "User", ai_label: "AI", ...(withRecovery ? { recovery } : {}) }, response());
}

describe("optional question-based recovery", () => {
  it("adds optional recovery fields to an existing account without modifying its credentials", async () => {
    const legacy = createClient({ url: pathToFileURL(path.join(directory, "legacy.sqlite")).href });
    try {
      await legacy.execute("CREATE TABLE user_account (id integer PRIMARY KEY, password_hash text NOT NULL, password_changed_at integer NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)");
      await legacy.execute({ sql: "INSERT INTO user_account VALUES (1, ?, 1, 1, 1)", args: ["existing-password-hash"] });
      await legacy.executeMultiple(await fs.readFile(path.resolve("drizzle/0004_password_recovery.sql"), "utf8"));
      const row = (await legacy.execute("SELECT * FROM user_account")).rows[0];
      expect(row.password_hash).toBe("existing-password-hash");
      expect(row.password_changed_at).toBe(1);
      expect(row.recovery_question).toBeNull();
      expect(row.recovery_answer_hash).toBeNull();
      expect(row.recovery_attempts).toBe(0);
    } finally { legacy.close(); }
  });
  it("exposes recovery without login but requires a session, CSRF and current password to configure it", async () => {
    await setup(false);
    const request = (url: string, method = "GET", body?: object, headers: Record<string, string> = {}) => fetch(`${baseUrl}${url}`, {
      method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined
    });
    expect((await request("/recovery")).status).toBe(200);
    expect((await request("/recovery", "PUT", { current_password: password, recovery })).status).toBe(401);
    const signIn = await request("/login", "POST", { password });
    const cookies = signIn.headers.getSetCookie().map((cookie) => cookie.split(";")[0]);
    const cookie = cookies.join("; ");
    const csrf = decodeURIComponent(cookies.find((value) => value.startsWith("phosphene_csrf="))!.split("=")[1]);
    expect((await request("/recovery", "PUT", { current_password: password, recovery }, { cookie })).status).toBe(403);
    expect((await request("/recovery", "PUT", { current_password: "wrong", recovery }, { cookie, "x-csrf-token": csrf })).status).toBe(401);
    expect((await request("/recovery", "PUT", { current_password: password, recovery }, { cookie, "x-csrf-token": csrf })).status).toBe(200);
    const question = await request("/recovery");
    expect(question.headers.get("cache-control")).toBe("no-store");
    expect(await question.json()).toEqual({ ok: true, data: { enabled: true, question: recovery.question } });
    const reset = await request("/recovery/reset", "POST", { answer: recovery.answer, new_password: nextPassword });
    expect(reset.status).toBe(200);
    expect(reset.headers.getSetCookie().join(";")).toContain("phosphene_session=;");
    expect((await request("/me", "GET", undefined, { cookie })).status).toBe(401);
  });
  it.each(["张", "小明", "0101", "a", "生日", " A "])("accepts simple, user-chosen answers: %s", (answer) => {
    expect(recoveryQuestionSchema.parse({ question: "我的问题", answer }).answer).toBe(answer.trim());
  });

  it("keeps recovery disabled before setup and when skipped", async () => {
    expect(await getRecoveryStatus()).toEqual({ enabled: false, question: null });
    await setup(false);
    expect(await getRecoveryStatus()).toEqual({ enabled: false, question: null });
    await expect(resetPasswordWithRecovery({ answer: "anything", new_password: nextPassword })).rejects.toMatchObject({ code: "recovery_not_configured" });
    await expect(login(password, response())).resolves.toBeTruthy();
  });

  it("stores only a salted answer hash and exposes just the question", async () => {
    await setup();
    const account = (await getDb().query.userAccount.findFirst())!;
    expect(account.recoveryAnswerHash).toMatch(/^\$argon2id\$/);
    expect(account.recoveryAnswerHash).not.toBe(recovery.answer);
    expect(await argon2.verify(account.recoveryAnswerHash!, recovery.answer)).toBe(true);
    expect(await getRecoveryStatus()).toEqual({ enabled: true, question: recovery.question });
  });

  it("resets the password and revokes all sessions without changing AI tokens or settings", async () => {
    await setup();
    await login(password, response());
    const tokens = await getDb().query.aiTokens.findMany();
    const settings = await getDb().query.appSettings.findFirst();
    await resetPasswordWithRecovery({ answer: " 0101 ", new_password: nextPassword });
    expect(await getDb().query.sessions.findMany({ where: isNull(sessions.revokedAt) })).toHaveLength(0);
    expect(await getDb().query.aiTokens.findMany()).toEqual(tokens);
    expect(await getDb().query.appSettings.findFirst()).toEqual(settings);
    await expect(login(password, response())).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(login(nextPassword, response())).resolves.toBeTruthy();
    expect(await getRecoveryStatus()).toEqual({ enabled: true, question: recovery.question });
    const audit = await getDb().query.auditLogs.findMany({ where: eq(auditLogs.action, "password.recovered") });
    expect(JSON.stringify(audit)).not.toContain(recovery.answer);
  });

  it("requires the current password to add, replace, or disable recovery", async () => {
    await setup(false);
    await expect(saveRecoverySettings({ current_password: "wrong", recovery })).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(await getRecoveryStatus()).toEqual({ enabled: false, question: null });
    await saveRecoverySettings({ current_password: password, recovery });
    await saveRecoverySettings({ current_password: password, recovery: { question: "名字？", answer: "小明" } });
    await expect(resetPasswordWithRecovery({ answer: "0101", new_password: nextPassword })).rejects.toMatchObject({ code: "invalid_recovery_answer" });
    await resetPasswordWithRecovery({ answer: "小明", new_password: nextPassword });
    await expect(saveRecoverySettings({ current_password: password, recovery: null })).rejects.toMatchObject({ code: "invalid_credentials" });
    await saveRecoverySettings({ current_password: nextPassword, recovery: null });
    expect(await getRecoveryStatus()).toEqual({ enabled: false, question: null });
    expect((await getDb().query.userAccount.findFirst())?.recoveryAnswerHash).toBeNull();
  });

  it("does not change credentials or revoke sessions for wrong answers or invalid new passwords", async () => {
    await setup();
    const originalHash = (await getDb().query.userAccount.findFirst())!.passwordHash;
    await expect(resetPasswordWithRecovery({ answer: "wrong", new_password: nextPassword })).rejects.toMatchObject({ code: "invalid_recovery_answer" });
    await expect(resetPasswordWithRecovery({ answer: recovery.answer, new_password: "abcdefghij！" })).rejects.toThrow();
    expect((await getDb().query.userAccount.findFirst())?.passwordHash).toBe(originalHash);
    expect(await getDb().query.sessions.findMany({ where: isNull(sessions.revokedAt) })).toHaveLength(1);
  });

  it("limits parallel attempts durably but leaves normal login available", async () => {
    await setup();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => resetPasswordWithRecovery({ answer: "wrong", new_password: nextPassword })));
    expect(results.filter((result) => result.status === "rejected" && result.reason.code === "invalid_recovery_answer")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected" && result.reason.code === "recovery_rate_limited")).toHaveLength(3);
    await shutdownDatabase();
    await initializeDatabase();
    await expect(resetPasswordWithRecovery({ answer: recovery.answer, new_password: nextPassword })).rejects.toMatchObject({ code: "recovery_rate_limited" });
    await expect(login(password, response())).resolves.toBeTruthy();
    await getDb().update(userAccount).set({ recoveryWindowStartedAt: new Date(Date.now() - 16 * 60 * 1000) });
    await expect(resetPasswordWithRecovery({ answer: recovery.answer, new_password: nextPassword })).resolves.toBeUndefined();
  });

  it("keeps answer case meaningful and clears cooldown on an authenticated password change", async () => {
    await setup();
    await saveRecoverySettings({ current_password: password, recovery: { question: "名字？", answer: "Alice" } });
    await expect(resetPasswordWithRecovery({ answer: "alice", new_password: nextPassword })).rejects.toMatchObject({ code: "invalid_recovery_answer" });
    await getDb().update(userAccount).set({ recoveryAttempts: 5, recoveryWindowStartedAt: new Date() });
    await changePassword(password, nextPassword);
    await expect(resetPasswordWithRecovery({ answer: "Alice", new_password: password })).resolves.toBeUndefined();
  });

  it("does not let an in-flight reset overwrite a newer password", async () => {
    await setup();
    const originalHash = argon2.hash;
    let release!: () => void;
    let reached!: () => void;
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(argon2, "hash").mockImplementation((async (...args: Parameters<typeof argon2.hash>) => {
      if (args[0] === nextPassword) { reached(); await gate; }
      return originalHash(...args);
    }) as typeof argon2.hash);
    const reset = resetPasswordWithRecovery({ answer: recovery.answer, new_password: nextPassword });
    const rejected = expect(reset).rejects.toMatchObject({ code: "credentials_changed" });
    await ready;
    try { await changePassword(password, "newer-password-789"); } finally { release(); }
    await rejected;
    await expect(login("newer-password-789", response())).resolves.toBeTruthy();
  });
});
