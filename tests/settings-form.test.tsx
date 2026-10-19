// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/web/App";
import { api } from "../src/web/api";

vi.mock("../src/web/api", () => ({ api: vi.fn(), idempotencyKey: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("keeps security after backup and focuses AI connection on connection details", async () => {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/bootstrap" || path === "/settings") {
      return { initialized: true, timezone: "Asia/Shanghai", user_label: "你", ai_label: "AI" };
    }
    if (path === "/ai-tokens" || path === "/oauth/grants") return [];
    return {};
  });
  render(<MemoryRouter initialEntries={["/settings"]}><App /></MemoryRouter>);
  const security = await screen.findByRole("button", { name: "登录安全" });
  const nav = security.closest("nav")!;
  expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual([
    "称呼与时间", "边界与惩罚", "AI 连接", "完成通知", "数据与备份", "登录安全"
  ]);
  fireEvent.click(within(nav).getByRole("button", { name: "AI 连接" }));
  expect(await screen.findByText("MCP ENDPOINT")).toBeTruthy();
  expect(screen.getByRole("button", { name: "轮换 AI Token" })).toBeTruthy();
  expect(screen.queryByText(/恰好 7 个工具/)).toBeNull();
  expect(document.querySelector(".tool-count")).toBeNull();
});
