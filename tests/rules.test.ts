import { describe, expect, it } from "vitest";
import {
  DIFFICULTY_MULTIPLIER,
  SUPPORTED_TIMEZONES,
  TIMEZONE_OPTIONS,
  streakBonusForDay
} from "../src/shared/constants";
import {
  createTaskSchema,
  manageTaskSchema,
  taskQuerySchema,
  webhookSettingsSchema
} from "../src/shared/schemas";
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
  it("offers a concise, valid set of common timezone choices", () => {
    expect(TIMEZONE_OPTIONS).toHaveLength(9);
    expect(SUPPORTED_TIMEZONES).toContain("Asia/Shanghai");
    expect(SUPPORTED_TIMEZONES).toContain("America/New_York");
    for (const timezone of SUPPORTED_TIMEZONES) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format()).not.toThrow();
    }
  });

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

  it("rejects calendar dates and cursors that only look valid", () => {
    expect(() =>
      createTaskSchema.parse({
        title: "Impossible date",
        type: "daily",
        base_points: 1,
        start_date: "2026-02-31",
        idempotency_key: "invalid-calendar-date"
      })
    ).toThrow();
    expect(() =>
      taskQuerySchema.parse({
        include_proof: false,
        limit: 10,
        cursor: "not-a-timestamp"
      })
    ).toThrow();
  });

  it("requires a useful reason when an AI rejects a submission", () => {
    expect(() =>
      manageTaskSchema.parse({
        action: "review",
        task_id: "task_review",
        decision: "reject",
        idempotency_key: "reject-without-reason"
      })
    ).toThrow(/必须说明理由/);
    expect(() =>
      manageTaskSchema.parse({
        action: "review",
        task_id: "task_review",
        decision: "approve",
        idempotency_key: "approve-without-reason"
      })
    ).not.toThrow();
  });

  it("rejects contradictory task lifecycle fields before they reach the database", () => {
    const base = {
      title: "Lifecycle validation",
      type: "challenge" as const,
      difficulty: "easy" as const,
      base_points: 1,
      verification_mode: "self" as const,
      proof_requirement: "none" as const,
      recurrence: "once" as const,
      daily_deadline_time: "23:59",
      reveal_mode: "immediate" as const,
      idempotency_key: "lifecycle-validation"
    };
    expect(() => createTaskSchema.parse({ ...base, start_date: "2026-08-30" }))
      .toThrow(/一次性任务/);
    expect(() => createTaskSchema.parse({
      ...base,
      type: "daily",
      recurrence: "daily",
      start_date: "2026-08-30",
      reveal_mode: "next_visit"
    })).toThrow(/固定立即展示/);
    expect(() => createTaskSchema.parse({
      ...base,
      reveal_mode: "at_time",
      visible_at: "2026-08-31T10:00:00+08:00",
      deadline: "2026-08-31T09:00:00+08:00"
    })).toThrow(/截止时间之前揭晓/);
  });

  it("validates Webhook subscriptions independently from AI credentials", () => {
    expect(() => webhookSettingsSchema.parse({
      enabled: true,
      url: "",
      event_types: ["task.completed"]
    })).toThrow(/地址/);
    expect(() => webhookSettingsSchema.parse({
      enabled: true,
      url: "https://user:secret@example.com/events",
      event_types: ["task.completed"]
    })).toThrow();
    expect(() => webhookSettingsSchema.parse({
      enabled: true,
      url: "https://example.com/events",
      event_types: ["notification.test"]
    })).toThrow();
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
