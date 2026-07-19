export const TASK_TYPES = ["daily", "challenge", "surprise"] as const;
export const TASK_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const TASK_STATUSES = [
  "pending",
  "submitted",
  "completed",
  "failed",
  "expired",
  "cancelled"
] as const;
export const VERIFICATION_MODES = ["self", "ai_review"] as const;
export const PROOF_REQUIREMENTS = [
  "none",
  "text",
  "image",
  "text_or_image",
  "text_and_image"
] as const;
export const AI_PROOF_REQUIREMENTS = [
  "none",
  "text",
  "text_and_image"
] as const;
export const RECURRENCE_MODES = ["once", "daily"] as const;
export const REVEAL_MODES = ["immediate", "next_visit", "at_time"] as const;
export const ACTORS = ["AI", "user", "system"] as const;

export const TIMEZONE_OPTIONS = [
  { value: "Asia/Shanghai", label: "中国标准时间 · 上海" },
  { value: "Asia/Tokyo", label: "日本标准时间 · 东京" },
  { value: "Asia/Seoul", label: "韩国标准时间 · 首尔" },
  { value: "Asia/Singapore", label: "新加坡时间" },
  { value: "Europe/London", label: "英国时间 · 伦敦" },
  { value: "Europe/Paris", label: "中欧时间 · 巴黎" },
  { value: "America/New_York", label: "美国东部时间 · 纽约" },
  { value: "America/Los_Angeles", label: "美国西部时间 · 洛杉矶" },
  { value: "Australia/Sydney", label: "澳大利亚东部时间 · 悉尼" }
] as const;

export const SUPPORTED_TIMEZONES = TIMEZONE_OPTIONS.map((option) => option.value);
export type SupportedTimezone = (typeof TIMEZONE_OPTIONS)[number]["value"];

export const DIFFICULTY_MULTIPLIER = {
  easy: 1,
  medium: 2,
  hard: 3
} as const;

export const MAX_PROOF_IMAGES = 4;
export const MAX_PROOF_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PROOF_IMAGE_PIXELS = 24_000_000;

export function streakBonusForDay(streak: number): number {
  if (streak >= 8) return 3;
  if (streak >= 6) return 2;
  if (streak >= 2) return 1;
  return 0;
}
