import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import router, { apiErrorHandler } from "../src/server/routes";
import { changePassword, login, setupApplication } from "../src/server/services/auth";
import { PASSWORD_CHARACTER_ERROR } from "../src/shared/schemas";

vi.mock("../src/server/services/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/server/services/auth")>();
  const pass: RequestHandler = (_request, _response, next) => next();
  return {
    ...original,
    requireUser: pass,
    requireCsrf: pass,
    setupApplication: vi.fn().mockResolvedValue({}),
    changePassword: vi.fn().mockResolvedValue(undefined),
    login: vi.fn().mockResolvedValue({})
  };
});

const app = express();
app.use(express.json(), router, apiErrorHandler);
const server = app.listen(0, "127.0.0.1");
let baseUrl: string;
beforeAll(async () => {
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => vi.clearAllMocks());
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

async function request(path: string, method: string, body: object) {
  return fetch(`${baseUrl}${path}`, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
}

describe("password API validation", () => {
  it.each(["abcdefghij！", "abcdefghij\u200b", "abcdefghij\n"])("rejects invalid passwords before setup or password changes", async (password) => {
    const setup = await request("/setup", "POST", { password, timezone: "Asia/Shanghai" });
    expect(setup.status).toBe(400);
    expect((await setup.json()).error.details.fieldErrors.password).toContain(PASSWORD_CHARACTER_ERROR);
    expect(setupApplication).not.toHaveBeenCalled();

    const change = await request("/password", "PUT", { current_password: "old", new_password: password });
    expect(change.status).toBe(400);
    expect((await change.json()).error.details.fieldErrors.new_password).toContain(PASSWORD_CHARACTER_ERROR);
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("passes allowed new passwords and original current passwords through unchanged", async () => {
    const setup = await request("/setup", "POST", { password: "0123456789", timezone: "Asia/Shanghai" });
    expect(setup.status).toBe(201);
    expect(setupApplication).toHaveBeenCalledWith(expect.objectContaining({ password: "0123456789" }), expect.anything());

    const oldPassword = "旧密码Ａ！\u200b";
    const change = await request("/password", "PUT", { current_password: oldPassword, new_password: "!@#$%^&*()" });
    expect(change.status).toBe(200);
    expect(changePassword).toHaveBeenCalledWith(oldPassword, "!@#$%^&*()");
    const signIn = await request("/login", "POST", { password: oldPassword });
    expect(signIn.status).toBe(200);
    expect(login).toHaveBeenCalledWith(oldPassword, expect.anything());
  });
});
