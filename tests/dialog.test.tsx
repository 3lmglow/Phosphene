// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/web/App";
import { api } from "../src/web/api";

vi.mock("../src/web/api", () => ({ api: vi.fn(), idempotencyKey: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("asks in an in-app dialog before rotating the AI token, closes on Esc and returns focus", async () => {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/bootstrap" || path === "/settings") {
      return { initialized: true, timezone: "Asia/Shanghai", user_label: "你", ai_label: "AI" };
    }
    if (path === "/ai-tokens" || path === "/oauth/grants") return [];
    if (path === "/ai-tokens/rotate") return { id: "token_new", token: "new-secret-token" };
    return {};
  });
  render(<MemoryRouter initialEntries={["/settings"]}><App /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "AI 连接" }));
  const rotate = await screen.findByRole("button", { name: "轮换 AI Token" });
  const rotateCalls = () => vi.mocked(api).mock.calls.filter(([path]) => path === "/ai-tokens/rotate");

  rotate.focus();
  fireEvent.click(rotate);
  fireEvent.click(await screen.findByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(rotateCalls()).toHaveLength(0);

  fireEvent.click(rotate);
  const dialog = await screen.findByRole("dialog", { name: "轮换 AI Token？" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(rotate);
  expect(rotateCalls()).toHaveLength(0);

  fireEvent.click(rotate);
  fireEvent.click(await screen.findByRole("button", { name: "轮换" }));
  await waitFor(() => expect(rotateCalls()).toHaveLength(1));
  expect(await screen.findByText("新的 Token 只显示这一次")).toBeTruthy();
});
