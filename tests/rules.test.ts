import { describe, expect, it } from "vitest";
import { DIFFICULTY_MULTIPLIER, streakBonusForDay } from "../src/shared/constants";
import { addCalendarDays, localDate, localDateTime } from "../src/server/lib/dates";

describe("frozen scoring rules", () => {
  it("uses the documented difficulty multipliers", () => {
    expect(DIFFICULTY_MULTIPLIER).toEqual({ easy: 1, medium: 2, hard: 3 });
  });

  it.each([
    [1, 0],
    [2, 1],
    [5, 1],
    [6, 2],
    [7, 2],
    [8, 3],
    [100, 3]
  ])("awards streak day %i with %i points", (day, points) => {
    expect(streakBonusForDay(day)).toBe(points);
  });
});

describe("timezone-safe calendar helpers", () => {
  it("keeps local dates stable across UTC boundaries", () => {
    expect(localDate(new Date("2026-07-18T16:30:00.000Z"), "Asia/Shanghai")).toBe("2026-07-19");
    expect(localDate(new Date("2026-07-19T03:30:00.000Z"), "America/New_York")).toBe("2026-07-18");
  });

  it("constructs a local deadline and advances calendar dates", () => {
    expect(localDateTime("2026-07-19", "23:30", "Asia/Shanghai").toISOString()).toBe(
      "2026-07-19T15:30:00.000Z"
    );
    expect(addCalendarDays("2024-02-28", 1)).toBe("2024-02-29");
  });
});
