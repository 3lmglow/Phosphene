import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

export function localDate(at: Date, timezone: string): string {
  return formatInTimeZone(at, timezone, "yyyy-MM-dd");
}

export function localTime(at: Date, timezone: string): string {
  return formatInTimeZone(at, timezone, "HH:mm");
}

export function localDateTime(date: string, time: string, timezone: string): Date {
  return fromZonedTime(`${date}T${time}:00`, timezone);
}

export function addCalendarDays(date: string, amount: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

export function compareDates(left: string, right: string): number {
  return left.localeCompare(right);
}

export function yesterday(date: string): string {
  return addCalendarDays(date, -1);
}
