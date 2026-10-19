import { useEffect, useRef } from "react";

export type ActivityCalendarData = {
  from: string;
  to: string;
  days: Array<{ date: string; completed: number }>;
};

const DAY_MS = 86_400_000;
const WEEKDAY_LABELS = ["一", "", "三", "", "五", "", ""];

function dayNumber(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function dateFromNumber(value: number) {
  return new Date(value * DAY_MS).toISOString().slice(0, 10);
}

export function activityLevel(completed: number) {
  if (completed <= 0) return 0;
  if (completed === 1) return 1;
  if (completed === 2) return 2;
  return completed <= 4 ? 3 : 4;
}

export function buildActivityWeeks({ from, to, days }: ActivityCalendarData) {
  const counts = new Map(days.map((day) => [day.date, day.completed]));
  const first = dayNumber(from);
  const last = dayNumber(to);
  const mondayOffset = (new Date(first * DAY_MS).getUTCDay() + 6) % 7;
  const weeks: Array<Array<{ date: string; completed: number } | null>> = [];
  for (let start = first - mondayOffset; start <= last; start += 7) {
    weeks.push(
      Array.from({ length: 7 }, (_, index) => {
        const value = start + index;
        if (value < first || value > last) return null;
        const date = dateFromNumber(value);
        return { date, completed: counts.get(date) ?? 0 };
      })
    );
  }
  return weeks;
}

export function monthLabels(weeks: Array<Array<{ date: string } | null>>) {
  const labels = weeks.map((week, index) => {
    const days = week.filter((day): day is { date: string } => Boolean(day));
    const monthStart = days.find((day) => day.date.endsWith("-01"));
    if (monthStart) return `${Number(monthStart.date.slice(5, 7))}月`;
    return index === 0 && days[0] ? `${Number(days[0].date.slice(5, 7))}月` : "";
  });
  if (labels[1] || labels[2]) labels[0] = "";
  return labels;
}

function dayTitle(date: string, completed: number) {
  const label = `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
  return completed ? `${label} · 完成 ${completed} 项` : `${label} · 没有完成任务`;
}

export function ActivityCalendar({ data }: { data: ActivityCalendarData }) {
  const scroller = useRef<HTMLDivElement>(null);
  const weeks = buildActivityWeeks(data);
  const months = monthLabels(weeks);
  const activeDays = data.days.filter((day) => day.completed > 0).length;
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [data]);
  return (
    <div className="activity-calendar">
      <div className="activity-calendar__scroll" ref={scroller}>
        <div
          className="activity-calendar__grid"
          role="img"
          aria-label={`最近一年有 ${activeDays} 天完成了任务`}
          style={{ gridTemplateColumns: `auto repeat(${weeks.length}, var(--activity-cell))` }}
        >
          <span />
          {months.map((label, index) => (
            <span key={`month-${index}`} className="activity-calendar__month">{label}</span>
          ))}
          {WEEKDAY_LABELS.map((label, row) => (
            <div key={`row-${row}`} className="activity-calendar__row">
              <span className="activity-calendar__weekday">{label}</span>
              {weeks.map((week, index) => {
                const day = week[row];
                return day ? (
                  <span
                    key={day.date}
                    className={`activity-cell activity-cell--${activityLevel(day.completed)}${day.date === data.to ? " activity-cell--today" : ""}`}
                    title={dayTitle(day.date, day.completed)}
                  />
                ) : (
                  <span key={`empty-${index}`} className="activity-cell activity-cell--empty" />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="activity-calendar__legend" aria-hidden="true">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((level) => <i key={level} className={`activity-cell activity-cell--${level}`} />)}
        <span>多</span>
      </div>
    </div>
  );
}
