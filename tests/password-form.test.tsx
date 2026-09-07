// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/web/App";
import { api } from "../src/web/api";
import { PASSWORD_CHARACTER_ERROR, PASSWORD_REQUIREMENTS } from "../src/shared/schemas";

vi.mock("../src/web/api", () => ({ api: vi.fn(), idempotencyKey: vi.fn() }));
const mockedApi = vi.mocked(api);
const bootstrap = {
  initialized: false, setup_protected: false, timezone: "Asia/Shanghai", user_label: "你", ai_label: "AI"
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("password form guidance and feedback", () => {
  it("blocks invalid setup passwords, preserves input, and allows correction", async () => {
    mockedApi.mockResolvedValue(bootstrap);
    render(<MemoryRouter><App /></MemoryRouter>);
    const password = await screen.findByLabelText(/登录密码/);
    const confirm = screen.getByLabelText("再次输入密码");
    expect(screen.getByText(PASSWORD_REQUIREMENTS)).toBeTruthy();
    expect(password.getAttribute("aria-describedby")).toBe("setup-password-rules");
    for (const invalid of ["abcdefghij！", "abcdefghij\u200b", "abcde fghij"]) {
      fireEvent.change(password, { target: { value: invalid } });
      fireEvent.change(confirm, { target: { value: invalid } });
      fireEvent.click(screen.getByRole("button", { name: "继续" }));
      expect(screen.getByRole("alert").textContent).toBe(PASSWORD_CHARACTER_ERROR);
      expect((password as HTMLInputElement).value).toBe(invalid);
      expect(mockedApi).toHaveBeenCalledTimes(1);
    }
    fireEvent.change(password, { target: { value: "0123456789" } });
    fireEvent.change(confirm, { target: { value: "0123456789" } });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("再告诉我，怎么称呼你们")).toBeTruthy();
  });

  it("shows change-password feedback before making any request and permits a non-ASCII current password", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/bootstrap") return { ...bootstrap, initialized: true };
      if (path === "/settings") return bootstrap;
      if (path === "/ai-tokens") return [];
      if (path === "/password") throw new Error("测试服务端反馈");
      return {};
    });
    render(<MemoryRouter initialEntries={["/settings"]}><App /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "登录安全" }));
    const password = await screen.findByLabelText(/新密码/);
    expect(screen.getByText(PASSWORD_REQUIREMENTS)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "旧密码Ａ！" } });
    fireEvent.change(password, { target: { value: "abcdefghij！" } });
    fireEvent.click(screen.getByRole("button", { name: "更新密码" }));
    expect(screen.getByRole("alert").textContent).toBe(PASSWORD_CHARACTER_ERROR);
    expect(mockedApi.mock.calls.some(([path]) => path === "/password")).toBe(false);
    fireEvent.change(password, { target: { value: "!@#$%^&*()" } });
    fireEvent.click(screen.getByRole("button", { name: "更新密码" }));
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith("/password", {
      method: "PUT", body: { current_password: "旧密码Ａ！", new_password: "!@#$%^&*()" }
    }));
    expect((await screen.findByRole("alert")).textContent).toBe("测试服务端反馈");
  });
});
