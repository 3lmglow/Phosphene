// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/web/App";
import { api } from "../src/web/api";

vi.mock("../src/web/api", () => ({ api: vi.fn(), idempotencyKey: vi.fn() }));

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
  visibility = "visible";
});

type Status = {
  enabled: boolean;
  current_version: string;
  latest: { version: string; name: string; url: string; published_at: string | null } | null;
  update_available: boolean;
  checked_at: string | null;
  check_failed: boolean;
};

// The server's own GitHub check finishes while the page is open: from then on /updates reports a new version.
function mockServer() {
  let status: Status = { enabled: true, current_version: "1.4.0", latest: null, update_available: false, checked_at: null, check_failed: false };
  let statusAsked!: () => void;
  const firstStatusRequest = new Promise<void>((resolve) => {
    statusAsked = resolve;
  });
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/bootstrap") return { initialized: true, timezone: "Asia/Shanghai", user_label: "你", ai_label: "AI" };
    if (path === "/me") return { authenticated: true };
    if (path === "/updates") {
      statusAsked();
      return status;
    }
    if (path === "/overview") return { labels: { user: "你", ai: "AI" }, statistics: { balance: 0 } };
    if (path === "/rewards" || path === "/redemptions") return [];
    throw new Error(`Unexpected request ${path}`);
  });
  return {
    firstStatusRequest,
    publishRelease() {
      status = {
        ...status,
        latest: { version: "1.5.0", name: "Phosphene 1.5.0", url: "https://github.com/3lmglow/Phosphene/releases/tag/v1.5.0", published_at: null },
        update_available: true,
        checked_at: "2026-11-09T02:00:00.000Z"
      };
    },
    statusRequests: () => vi.mocked(api).mock.calls.filter(([path]) => path === "/updates").length
  };
}

// The page can show up before React has run its effects, which is where it first asks for the version status and
// starts listening for the page coming back into view; wait for that request rather than assume it was quick.
async function openApp(server: ReturnType<typeof mockServer>) {
  render(<MemoryRouter initialEntries={["/rewards"]}><App /></MemoryRouter>);
  await screen.findByRole("heading", { name: "兑换", level: 1 });
  await server.firstStatusRequest;
}

it("asks the server for the version status again when the page comes back into view", async () => {
  const server = mockServer();
  await openApp(server);
  expect(server.statusRequests()).toBe(1);
  expect(screen.queryByRole("img", { name: "有新版本" })).toBeNull();

  server.publishRelease();
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(server.statusRequests()).toBe(1);

  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(server.statusRequests()).toBe(2);
  expect(await screen.findByRole("img", { name: "有新版本" })).toBeTruthy();
});

it("asks again every half hour while the page stays open, but not while it is hidden", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const server = mockServer();
  await openApp(server);
  expect(server.statusRequests()).toBe(1);

  server.publishRelease();
  visibility = "hidden";
  vi.advanceTimersByTime(30 * 60_000);
  expect(server.statusRequests()).toBe(1);

  visibility = "visible";
  vi.advanceTimersByTime(29 * 60_000);
  expect(server.statusRequests()).toBe(1);
  vi.advanceTimersByTime(60_000);
  expect(server.statusRequests()).toBe(2);
  expect(await screen.findByRole("img", { name: "有新版本" })).toBeTruthy();
});
