// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/web/App";
import { api } from "../src/web/api";
import { formatDayHeading, formatInstant, localHour, validTimeZone } from "../src/web/time";

vi.mock("../src/web/api", () => ({ api: vi.fn(), idempotencyKey: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("instance time zone formatting", () => {
  const instant = "2026-10-19T15:30:00.000Z";

  it("formats instants in the given zone instead of the device zone", () => {
    expect(formatInstant(instant, true, "Asia/Shanghai")).toBe("10月19日 23:30");
    expect(formatInstant(instant, true, "America/New_York")).toBe("10月19日 11:30");
    expect(formatInstant(null, true, "Asia/Shanghai")).toBe("没有期限");
  });

  it("derives the greeting hour and day heading from the instance zone", () => {
    const date = new Date(instant);
    expect(localHour(date, "Asia/Shanghai")).toBe(23);
    expect(localHour(date, "Asia/Tokyo")).toBe(0);
    expect(formatDayHeading(date, "Asia/Tokyo")).toBe("10月20日星期二");
  });

  it("falls back to the device zone for an unusable stored zone", () => {
    expect(validTimeZone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(validTimeZone("Not/A_Zone")).toBeUndefined();
    expect(validTimeZone("")).toBeUndefined();
  });
});

it("shows redemption times in the instance zone and the AI's fulfillment note", async () => {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/bootstrap") {
      return { initialized: true, timezone: "America/New_York", user_label: "你", ai_label: "星沉" };
    }
    if (path === "/overview") return { labels: { user: "你", ai: "星沉" }, statistics: { balance: 3 } };
    if (path === "/rewards") return [];
    if (path === "/redemptions") {
      return [{
        id: "redemption_1",
        itemNameSnapshot: "写一首诗",
        costSnapshot: 15,
        status: "fulfilled",
        redeemedAt: "2026-10-19T15:30:00.000Z",
        fulfilledAt: "2026-10-20T01:05:00.000Z",
        fulfillmentNote: "诗已经写好了，\n放在你的信箱里。"
      }];
    }
    return {};
  });
  render(<MemoryRouter initialEntries={["/rewards"]}><App /></MemoryRouter>);

  expect(await screen.findByText("10月19日 11:30 兑换 · 10月19日 21:05 履行")).toBeTruthy();
  const note = screen.getByText(/星沉 留言：诗已经写好了/);
  expect(note.textContent).toBe("星沉 留言：诗已经写好了，\n放在你的信箱里。");
});
