// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityCalendar, activityLevel, buildActivityWeeks, monthLabels } from "../src/web/ActivityCalendar";

afterEach(cleanup);

describe("activity calendar", () => {
  const data = {
    from: "2025-10-21",
    to: "2026-10-19",
    days: [
      { date: "2025-10-21", completed: 1 },
      { date: "2026-10-18", completed: 3 },
      { date: "2026-10-19", completed: 6 }
    ]
  };

  it("lays the range out in Monday-first weeks without days outside it", () => {
    const weeks = buildActivityWeeks(data);
    expect(weeks[0][0]).toBeNull();
    expect(weeks[0][1]).toEqual({ date: "2025-10-21", completed: 1 });
    const last = weeks.at(-1)!;
    expect(last[0]).toEqual({ date: "2026-10-19", completed: 6 });
    expect(last.slice(1).every((day) => day === null)).toBe(true);
    expect(weeks.flat().filter(Boolean)).toHaveLength(364);
  });

  it("does not crowd the first month label into the next one", () => {
    const labels = monthLabels(buildActivityWeeks(data));
    expect(labels[0]).toBe("");
    expect(labels[1]).toBe("11月");
    expect(labels.filter(Boolean)).toHaveLength(12);
  });

  it("buckets completions into five shades", () => {
    expect([0, 1, 2, 3, 4, 5, 12].map(activityLevel)).toEqual([0, 1, 2, 3, 3, 4, 4]);
  });

  it("labels each day for hover and summarises the range for screen readers", () => {
    const { container } = render(<ActivityCalendar data={data} />);
    expect(screen.getByRole("img", { name: "最近一年有 3 天完成了任务" })).toBeTruthy();
    expect(screen.getByTitle("10月19日 · 完成 6 项").className).toContain("activity-cell--today");
    expect(screen.getByTitle("10月18日 · 完成 3 项").className).toContain("activity-cell--3");
    expect(screen.getByTitle("10月17日 · 没有完成任务").className).toContain("activity-cell--0");
    expect([...container.querySelectorAll(".activity-calendar__month")].map((label) => label.textContent).filter(Boolean)[0]).toBe("11月");
  });
});
