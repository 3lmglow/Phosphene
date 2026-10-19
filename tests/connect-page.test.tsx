// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/web/App";
import { api } from "../src/web/api";
import { leavePage } from "../src/web/navigation";

vi.mock("../src/web/api", () => ({ api: vi.fn(), idempotencyKey: vi.fn() }));
vi.mock("../src/web/navigation", () => ({ leavePage: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function mockServer({ signedIn }: { signedIn: boolean }) {
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/bootstrap") return { initialized: true, timezone: "Asia/Shanghai", user_label: "你", ai_label: "AI" };
    if (path === "/me") {
      if (!signedIn) throw new Error("Please sign in");
      return { authenticated: true };
    }
    if (path === "/login") return { csrf_token: "csrf" };
    if (path === "/oauth/requests/req-1") return { client_name: "ChatGPT", redirect_host: "chatgpt.com" };
    if (path === "/oauth/requests/req-1/approve" && options?.method === "POST") {
      return { redirect_to: "https://chatgpt.com/connector_platform_oauth_redirect?code=abc&iss=x" };
    }
    if (path === "/oauth/requests/req-1/deny" && options?.method === "POST") {
      return { redirect_to: "https://chatgpt.com/connector_platform_oauth_redirect?error=access_denied" };
    }
    throw new Error(`Unexpected request ${path}`);
  });
}

it("asks a signed-in user to approve the app and hands the code back to it", async () => {
  mockServer({ signedIn: true });
  render(<MemoryRouter initialEntries={["/connect?request=req-1"]}><App /></MemoryRouter>);
  expect(await screen.findByRole("heading", { name: "「ChatGPT」想连接你的 Phosphene" })).toBeTruthy();
  expect(screen.getByText("chatgpt.com")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /允许连接/ }));
  await waitFor(() =>
    expect(leavePage).toHaveBeenCalledWith("https://chatgpt.com/connector_platform_oauth_redirect?code=abc&iss=x")
  );
});

it("asks for the password first when the browser is not signed in", async () => {
  mockServer({ signedIn: false });
  render(<MemoryRouter initialEntries={["/connect?request=req-1"]}><App /></MemoryRouter>);
  expect(await screen.findByRole("heading", { name: "「ChatGPT」想连接你的 Phosphene" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /允许连接/ })).toBeNull();
  fireEvent.change(screen.getByLabelText(/登录密码/), { target: { value: "my-password-123" } });
  fireEvent.click(screen.getByRole("button", { name: /登录并继续/ }));
  expect(await screen.findByRole("button", { name: /允许连接/ })).toBeTruthy();
  expect(api).toHaveBeenCalledWith("/login", { method: "POST", body: { password: "my-password-123" } });
});

it("explains a rejected request without offering to approve it", async () => {
  mockServer({ signedIn: true });
  render(<MemoryRouter initialEntries={["/connect?error=invalid_redirect_uri"]}><App /></MemoryRouter>);
  expect(await screen.findByText(/返回地址与应用登记的不一致/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /允许连接/ })).toBeNull();
});
