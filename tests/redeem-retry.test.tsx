// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/web/App";
import { api, ApiError } from "../src/web/api";
import { isDefinitiveRejection } from "../src/web/idempotency";

vi.mock("../src/web/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/web/api")>()),
  api: vi.fn()
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

type Outcome = () => unknown;
type Row = { id: string } & Record<string, unknown>;

const offline: Outcome = () => {
  throw new TypeError("Failed to fetch");
};
const serverError: Outcome = () => {
  throw new ApiError("internal_error", "服务器暂时出错了。", 500);
};
const notEnoughPoints: Outcome = () => {
  throw new ApiError("insufficient_points", "Not enough points for this reward", 409);
};
const redeemed = (id: string): Outcome => () => ({ redemption: { id }, balance: 80 });

// Each test redeems its own reward: the app keeps an unanswered key for as long as it stays open.
function mockServer(reward: { id: string; name: string }, outcomes: Outcome[], listed: () => Row[] = () => []) {
  const keys: string[] = [];
  let answer = () => {};
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/bootstrap") return { initialized: true, timezone: "Asia/Shanghai", user_label: "你", ai_label: "AI" };
    if (path === "/me") return { authenticated: true };
    if (path === "/updates") {
      return { enabled: false, current_version: "1.0.0", latest: null, update_available: false, checked_at: null, check_failed: false };
    }
    if (path === "/overview") return { labels: { user: "你", ai: "AI" }, statistics: { balance: 100 } };
    if (path === "/rewards") return [{ ...reward, description: "", cost: 20 }];
    if (path === "/redemptions") return listed();
    if (path === `/rewards/${reward.id}/redeem`) {
      keys.push((options?.body as { idempotency_key: string }).idempotency_key);
      // Hold the reply until the test sends it, so the page is seen waiting on every attempt.
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      const outcome = outcomes.shift();
      if (!outcome) throw new Error("No reply planned for this attempt");
      return outcome();
    }
    throw new Error(`Unexpected request ${path}`);
  });
  return { keys, answer: () => answer() };
}

async function redeem(name: string, server: { answer: () => void }) {
  const card = (await screen.findByRole("heading", { name })).closest("article")!;
  const button = within(card).getByRole("button") as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog", { name: `兑换「${name}」？` });
  fireEvent.click(within(dialog).getByRole("button", { name: "兑换" }));
  await waitFor(() => expect(button.textContent).toBe("兑换中…"));
  server.answer();
  await waitFor(() => expect(button.textContent).toBe("兑换"));
}

it("sends the same key again when retrying after the connection dropped or the server failed", async () => {
  const reward = { id: "reward-dinner", name: "星光晚餐" };
  const server = mockServer(reward, [offline, serverError, redeemed("redemption-dinner")]);
  render(<MemoryRouter initialEntries={["/rewards"]}><App /></MemoryRouter>);

  await redeem(reward.name, server);
  expect(await screen.findByText("Failed to fetch")).toBeTruthy();
  await redeem(reward.name, server);
  await redeem(reward.name, server);

  expect(screen.getByText(/兑换成功，20 积分已扣除/)).toBeTruthy();
  expect(server.keys).toHaveLength(3);
  expect(new Set(server.keys).size).toBe(1);
});

it("starts a new key for the next redemption once one has gone through", async () => {
  const reward = { id: "reward-walk", name: "一起散步" };
  const server = mockServer(reward, [serverError, redeemed("redemption-walk-1"), redeemed("redemption-walk-2")]);
  render(<MemoryRouter initialEntries={["/rewards"]}><App /></MemoryRouter>);

  await redeem(reward.name, server);
  await redeem(reward.name, server);
  await redeem(reward.name, server);

  const [failed, retried, next] = server.keys;
  expect(retried).toBe(failed);
  expect(next).not.toBe(retried);
});

it("starts a new key after the server turned the redemption down", async () => {
  const reward = { id: "reward-movie", name: "电影之夜" };
  const server = mockServer(reward, [notEnoughPoints, offline, redeemed("redemption-movie")]);
  render(<MemoryRouter initialEntries={["/rewards"]}><App /></MemoryRouter>);

  await redeem(reward.name, server);
  expect(await screen.findByText("Not enough points for this reward")).toBeTruthy();
  await redeem(reward.name, server);
  await redeem(reward.name, server);

  const [rejected, dropped, retried] = server.keys;
  expect(dropped).not.toBe(rejected);
  expect(retried).toBe(dropped);
});

it("says so when a retry finds the earlier attempt had already gone through", async () => {
  const reward = { id: "reward-call", name: "晚安电话" };
  let listed: Row[] = [];
  const server = mockServer(reward, [offline, redeemed("redemption-call"), redeemed("redemption-call-2")], () => listed);
  render(<MemoryRouter initialEntries={["/rewards"]}><App /></MemoryRouter>);

  await redeem(reward.name, server);
  // The reply was lost, but the server did record it; the page picks it up the next time it syncs.
  listed = [{
    id: "redemption-call",
    status: "pending",
    itemNameSnapshot: reward.name,
    costSnapshot: 20,
    redeemedAt: "2026-11-09T02:00:00.000Z"
  }];
  fireEvent.focus(window);
  expect(await screen.findByText("等待履行")).toBeTruthy();

  await redeem(reward.name, server);
  expect(screen.getByText(/上次兑换“晚安电话”其实已经成功，积分只扣了一次/)).toBeTruthy();
  await redeem(reward.name, server);
  expect(screen.getByText(/兑换成功，20 积分已扣除/)).toBeTruthy();

  const [lost, retried, next] = server.keys;
  expect(retried).toBe(lost);
  expect(next).not.toBe(retried);
});

it("treats only a readable 4xx reply as a clear no", () => {
  expect(isDefinitiveRejection(new ApiError("insufficient_points", "Not enough points", 409))).toBe(true);
  expect(isDefinitiveRejection(new ApiError("not_found", "Reward not found", 404))).toBe(true);
  expect(isDefinitiveRejection(new ApiError("internal_error", "Server error", 500))).toBe(false);
  expect(isDefinitiveRejection(new ApiError("request_failed", "请求没有成功，请稍后再试。", 413))).toBe(false);
  expect(isDefinitiveRejection(new TypeError("Failed to fetch"))).toBe(false);
});
