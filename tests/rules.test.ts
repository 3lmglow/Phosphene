import { describe, expect, it } from "vitest";
import { DIFFICULTY_MULTIPLIER, streakBonusForDay } from "../src/shared/constants";
import { addCalendarDays, localDate, localDateTime } from "../src/server/lib/dates";
import { resolveDeployment } from "../src/server/lib/deployment";

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

describe("deployment topology", () => {
  it("preserves an in-memory SQLite database for isolated tests", () => {
    expect(
      resolveDeployment({
        nodeEnv: "test",
        sqlitePath: ":memory:"
      }).sqlitePath
    ).toBe(":memory:");
  });

  it("uses one persistent data directory for the default production deployment", () => {
    const deployment = resolveDeployment({
      nodeEnv: "production",
      cwd: process.cwd()
    });
    expect(deployment.mode).toBe("single");
    expect(deployment.sqlitePath.startsWith(deployment.dataDir)).toBe(true);
    expect(deployment.localStoragePath.startsWith(deployment.dataDir)).toBe(true);
  });

  it("rejects temporary or out-of-volume production database paths", () => {
    expect(() =>
      resolveDeployment({
        nodeEnv: "production",
        sqlitePath: ":memory:"
      })
    ).toThrow(/persistent filesystem SQLITE_PATH/);
    expect(() =>
      resolveDeployment({
        nodeEnv: "production",
        sqlitePath: "/tmp/phosphene.sqlite"
      })
    ).toThrow(/stay inside PHOSPHENE_DATA_DIR/);
    expect(() =>
      resolveDeployment({
        nodeEnv: "production",
        dataDir: "relative-data"
      })
    ).toThrow(/absolute path/);
  });
});
