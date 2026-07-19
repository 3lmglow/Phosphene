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
export const RECURRENCE_MODES = ["once", "daily"] as const;
export const REVEAL_MODES = ["immediate", "next_visit", "at_time"] as const;
export const ACTORS = ["AI", "user", "system"] as const;

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
