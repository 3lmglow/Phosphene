// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/web/App";
import { api, ApiError } from "../src/web/api";
import { isRedemptionRefusal } from "../src/web/idempotency";

vi.mock("../src/web/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/web/api")>()),
  api: vi.fn()
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

// Stands in for the server's redemptions: the first request with a key records one, a repeat with the same key
// gets that one back and is marked as replayed.
function recordedRedemptions() {
  const byKey = new Map<string, { id: string; status: string; itemNameSnapshot: string; costSnapshot: number; redeemedAt: string }>();
  return {
    rows: () => [...byKey.values()],
    redeem(key: string, name: string) {
      const replayed = byKey.has(key);
      if (!replayed) {
        byKey.set(key, {
          id: `redemption-${byKey.size + 1}`,
          status: "pending",
          itemNameSnapshot: name,
          costSnapshot: 20,
          redeemedAt: "2026-11-09T02:00:00.000Z"
        });
      }
      return { redemption: byKey.get(key), balance: 80, replayed };
    }
  };
}

type Recorded = ReturnType<typeof recordedRedemptions>;
type Outcome = (key: string, recorded: Recorded, name: string) => unknown;

const offline: Outcome = () => {
  throw new TypeError("Failed to fetch");
};
const serverError: Outcome = () => {
  throw new ApiError("internal_error", "服务器暂时出错了。", 500);
};
const notEnoughPoints: Outcome = () => {
  throw new ApiError("insufficient_points", "Not enough points for this reward", 409);
};
// Turned away by the sign-in check, before the redemption looks at the key at all.
const signedOut: Outcome = () => {
  throw new ApiError("session_expired", "Your session has expired", 401);
};
const goesThrough: Outcome = (key, recorded, name) => recorded.redeem(key, name);
// The server redeemed, but the reply never reached the page.
const replyLost: Outcome = (key, recorded, name) => {
  recorded.redeem(key, name);
  throw new TypeError("Failed to fetch");
};

// Each test redeems its own reward: the app keeps an unanswered key for as long as it stays open.
function mockServer(reward: { id: string; name: string }, outcomes: Outcome[]) {
  const recorded = recordedRedemptions();
  const keys: string[] = [];
  const replies: Array<() => void> = [];
  let redemptionLoads = 0;
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/bootstrap") return { initialized: true, timezone: "Asia/Shanghai", user_label: "你", ai_label: "AI" };
    if (path === "/me") return { authenticated: true };
    if (path === "/updates") {
      return { enabled: false, current_version: "1.0.0", latest: null, update_available: false, checked_at: null, check_failed: false };
    }
    if (path === "/overview") return { labels: { user: "你", ai: "AI" }, statistics: { balance: 100 } };
    if (path === "/rewards") return [{ ...reward, description: "", cost: 20 }];
    if (path === "/redemptions") {
      redemptionLoads += 1;
      return recorded.rows();
    }
    if (path === `/rewards/${reward.id}/redeem`) {
      const key = (options?.body as { idempotency_key: string }).idempotency_key;
      keys.push(key);
      const outcome = outcomes.shift();
      // Hold the reply until the test sends it, so the page is seen waiting on every attempt.
      await new Promise<void>((resolve) => replies.push(resolve));
      if (!outcome) throw new Error("No reply planned for this attempt");
      return outcome(key, recorded, reward.name);
    }
    throw new Error(`Unexpected request ${path}`);
  });
  return {
    keys,
    redemptions: () => recorded.rows().length,
    redemptionLoads: () => redemptionLoads,
    // Answers the latest attempt, or an earlier one that is still waiting.
    answer: (attempt = replies.length - 1) => replies[attempt]()
  };
}

function openRewards() {
  return render(<MemoryRouter initialEntries={["/rewards"]}><App /></MemoryRouter>);
}

async function startRedeeming(name: string) {
  const card = (await screen.findByRole("heading", { name })).closest("article")!;
  const button = within(card).getByRole("button") as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog", { name: `兑换「${name}」？` });
  fireEvent.click(within(dialog).getByRole("button", { name: "兑换" }));
  await waitFor(() => expect(button.textContent).toBe("兑换中…"));
  return button;
}

async function redeem(name: string, server: { answer: () => void }) {
  const button = await startRedeeming(name);
  server.answer();
  await waitFor(() => expect(button.textContent).toBe("兑换"));
}

it("sends the same key again when retrying after the connection dropped or the server failed", async () => {
  const reward = { id: "reward-dinner", name: "星光晚餐" };
  const server = mockServer(reward, [offline, serverError, goesThrough]);
  openRewards();

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
  const server = mockServer(reward, [serverError, goesThrough, goesThrough]);
  openRewards();

  await redeem(reward.name, server);
  await redeem(reward.name, server);
  await redeem(reward.name, server);

  const [failed, retried, next] = server.keys;
  expect(retried).toBe(failed);
  expect(next).not.toBe(retried);
});

it("starts a new key after the server turned the redemption down", async () => {
  const reward = { id: "reward-movie", name: "电影之夜" };
  const server = mockServer(reward, [notEnoughPoints, offline, goesThrough]);
  openRewards();

  await redeem(reward.name, server);
  expect(await screen.findByText("Not enough points for this reward")).toBeTruthy();
  await redeem(reward.name, server);
  await redeem(reward.name, server);

  const [rejected, dropped, retried] = server.keys;
  expect(dropped).not.toBe(rejected);
  expect(retried).toBe(dropped);
});

it("keeps the key when a retry is turned away before the server could look at it", async () => {
  const reward = { id: "reward-letter", name: "一封手写信" };
  const server = mockServer(reward, [replyLost, signedOut, goesThrough]);
  openRewards();

  await redeem(reward.name, server);
  expect(await screen.findByText("Failed to fetch")).toBeTruthy();
  // Signed out in the meantime: this says nothing about whether the first attempt went through.
  await redeem(reward.name, server);
  expect(await screen.findByText("Your session has expired")).toBeTruthy();
  // Signed in again elsewhere and tried once more.
  await redeem(reward.name, server);

  expect(screen.getByText(/上次兑换“一封手写信”其实已经成功，积分只扣了一次/)).toBeTruthy();
  expect(new Set(server.keys).size).toBe(1);
  expect(server.redemptions()).toBe(1);
  expect(await screen.findAllByText("等待履行")).toHaveLength(1);
});

it("does not let a late reply to an older attempt drop the key of a newer redemption", async () => {
  const reward = { id: "reward-song", name: "点一首歌" };
  const server = mockServer(reward, [goesThrough, goesThrough, replyLost, goesThrough]);
  const firstVisit = openRewards();

  // The first attempt hangs; the user looks at another page and comes back, so the button works again.
  await startRedeeming(reward.name);
  firstVisit.unmount();
  openRewards();
  await redeem(reward.name, server);
  expect(screen.getByText(/兑换成功，20 积分已扣除/)).toBeTruthy();

  // A second redemption goes through, but its reply is lost.
  await redeem(reward.name, server);
  expect(await screen.findByText("Failed to fetch")).toBeTruthy();

  // Only now does the reply to the very first attempt arrive; the page that sent it reloads the list once done.
  const loads = server.redemptionLoads();
  server.answer(0);
  await waitFor(() => expect(server.redemptionLoads()).toBeGreaterThan(loads));

  await redeem(reward.name, server);
  expect(screen.getByText(/上次兑换“点一首歌”其实已经成功，积分只扣了一次/)).toBeTruthy();
  const [hung, retried, second, secondRetry] = server.keys;
  expect(retried).toBe(hung);
  expect(second).not.toBe(hung);
  expect(secondRetry).toBe(second);
  expect(server.redemptions()).toBe(2);
});

it("says so when an immediate retry finds the earlier attempt had already gone through", async () => {
  const reward = { id: "reward-call", name: "晚安电话" };
  const server = mockServer(reward, [replyLost, goesThrough, goesThrough]);
  openRewards();

  // The reply was lost and the page retries straight away, before its redemption list has caught up.
  await redeem(reward.name, server);
  expect(screen.queryByText("等待履行")).toBeNull();
  await redeem(reward.name, server);
  expect(screen.getByText(/上次兑换“晚安电话”其实已经成功，积分只扣了一次/)).toBeTruthy();
  await redeem(reward.name, server);
  expect(screen.getByText(/兑换成功，20 积分已扣除/)).toBeTruthy();

  const [lost, retried, next] = server.keys;
  expect(retried).toBe(lost);
  expect(next).not.toBe(retried);
  expect(server.redemptions()).toBe(2);
});

it("drops the key only for refusals that prove the redemption never happened", () => {
  expect(isRedemptionRefusal(new ApiError("insufficient_points", "Not enough points", 409))).toBe(true);
  expect(isRedemptionRefusal(new ApiError("not_found", "Reward not found", 404))).toBe(true);
  expect(isRedemptionRefusal(new ApiError("idempotency_conflict", "Key belongs to another operation", 409))).toBe(true);
  expect(isRedemptionRefusal(new ApiError("idempotency_payload_conflict", "Key used with other values", 409))).toBe(true);
  expect(isRedemptionRefusal(new ApiError("session_expired", "Your session has expired", 401))).toBe(false);
  expect(isRedemptionRefusal(new ApiError("authentication_required", "Please sign in", 401))).toBe(false);
  expect(isRedemptionRefusal(new ApiError("csrf_failed", "Security token is missing or invalid", 403))).toBe(false);
  expect(isRedemptionRefusal(new ApiError("request_failed", "请求没有成功，请稍后再试。", 429))).toBe(false);
  expect(isRedemptionRefusal(new ApiError("validation_error", "The request contains invalid values", 400))).toBe(false);
  expect(isRedemptionRefusal(new ApiError("request_failed", "请求没有成功，请稍后再试。", 413))).toBe(false);
  expect(isRedemptionRefusal(new ApiError("backup_maintenance", "A backup is in progress", 503))).toBe(false);
  expect(isRedemptionRefusal(new ApiError("internal_error", "Server error", 500))).toBe(false);
  expect(isRedemptionRefusal(new TypeError("Failed to fetch"))).toBe(false);
});
