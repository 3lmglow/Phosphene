export function validTimeZone(timeZone?: string | null): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

export function formatInstant(value?: string | null, withTime = false, timeZone?: string) {
  if (!value) return "没有期限";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    timeZone
  }).format(new Date(value));
}

export function formatDayHeading(date: Date, timeZone?: string) {
  return new Intl.DateTimeFormat("zh-CN", { weekday: "long", month: "long", day: "numeric", timeZone }).format(date);
}

export function localHour(date: Date, timeZone?: string) {
  return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(date));
}
