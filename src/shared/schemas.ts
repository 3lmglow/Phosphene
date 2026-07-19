import { z } from "zod";
import {
  PROOF_REQUIREMENTS,
  RECURRENCE_MODES,
  REVEAL_MODES,
  TASK_DIFFICULTIES,
  TASK_STATUSES,
  TASK_TYPES,
  VERIFICATION_MODES
} from "./constants";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "必须使用 YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), "日期无效");
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "必须为 HH:mm");
const timezone = z.string().min(1).max(80).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "必须使用有效的 IANA 时区，例如 Asia/Shanghai");

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(4000).optional().default(""),
    type: z.enum(TASK_TYPES),
    difficulty: z.enum(TASK_DIFFICULTIES).default("easy"),
    base_points: z.number().int().min(1).max(10000),
    verification_mode: z.enum(VERIFICATION_MODES).default("self"),
    proof_requirement: z.enum(PROOF_REQUIREMENTS).default("none"),
    recurrence: z.enum(RECURRENCE_MODES).default("once"),
    start_date: isoDate.optional(),
    end_date: isoDate.optional(),
    daily_deadline_time: localTime.optional().default("23:59"),
    deadline: z.string().datetime({ offset: true }).optional(),
    reveal_mode: z.enum(REVEAL_MODES).default("immediate"),
    visible_at: z.string().datetime({ offset: true }).optional(),
    related_task_id: z.string().min(1).optional(),
    idempotency_key: z.string().min(8).max(128)
  })
  .superRefine((value, ctx) => {
    if (value.type !== "daily" && value.recurrence !== "once") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recurrence"],
        message: "只有 daily 任务可以每日重复"
      });
    }
    if (value.type === "challenge" && !value.deadline) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadline"],
        message: "challenge 必须设置截止时间"
      });
    }
    if (value.recurrence === "daily" && value.deadline) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deadline"],
        message: "每日重复任务应使用 daily_deadline_time"
      });
    }
    if (value.reveal_mode === "at_time" && !value.visible_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["visible_at"],
        message: "定时揭晓必须提供 visible_at"
      });
    }
  });

export const taskQuerySchema = z.object({
  task_id: z.string().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  type: z.enum(TASK_TYPES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  include_proof: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(30),
  cursor: z.string().optional()
});

export const manageTaskSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("edit"),
    task_id: z.string(),
    scope: z.enum(["occurrence", "this_and_future"]).default("occurrence"),
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(4000).optional(),
    difficulty: z.enum(TASK_DIFFICULTIES).optional(),
    base_points: z.number().int().min(1).max(10000).optional(),
    deadline: z.string().datetime({ offset: true }).optional(),
    idempotency_key: z.string().min(8).max(128)
  }),
  z.object({
    action: z.enum(["cancel", "fail"]),
    task_id: z.string(),
    scope: z.enum(["occurrence", "this_and_future"]).default("occurrence"),
    reason: z.string().trim().min(1).max(1000),
    idempotency_key: z.string().min(8).max(128)
  }),
  z.object({
    action: z.literal("review"),
    task_id: z.string(),
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().max(1000).optional(),
    idempotency_key: z.string().min(8).max(128)
  }),
  z.object({
    action: z.enum(["pause_series", "resume_series"]),
    series_id: z.string(),
    reason: z.string().trim().max(1000).optional(),
    idempotency_key: z.string().min(8).max(128)
  })
]);

export const submitTaskSchema = z.object({
  proof_text: z.string().trim().max(4000).optional().default("")
});

export const rewardManageSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), include_archived: z.boolean().default(false) }),
  z.object({
    action: z.literal("create"),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).optional().default(""),
    cost: z.number().int().min(1).max(100000),
    idempotency_key: z.string().min(8).max(128)
  }),
  z.object({
    action: z.literal("update"),
    reward_id: z.string(),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).optional(),
    cost: z.number().int().min(1).max(100000).optional(),
    idempotency_key: z.string().min(8).max(128)
  }),
  z.object({
    action: z.literal("archive"),
    reward_id: z.string(),
    idempotency_key: z.string().min(8).max(128)
  }),
  z.object({ action: z.literal("list_redemptions"), status: z.enum(["pending", "fulfilled", "cancelled"]).optional() }),
  z.object({
    action: z.literal("fulfill_redemption"),
    redemption_id: z.string(),
    note: z.string().trim().max(1000).optional(),
    idempotency_key: z.string().min(8).max(128)
  })
]);

export const adjustPointsSchema = z
  .object({
    kind: z.enum(["bonus", "penalty", "correction"]),
    amount: z.number().int().min(-100000).max(100000),
    reason: z.string().trim().min(1).max(1000),
    related_task_id: z.string().optional(),
    idempotency_key: z.string().min(8).max(128)
  })
  .superRefine((value, ctx) => {
    if (value.amount === 0 || (value.kind !== "correction" && value.amount < 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: value.kind === "correction" ? "校正金额不能为 0" : "奖励和扣分金额必须大于 0"
      });
    }
  });

export const setupSchema = z.object({
  setup_token: z.string().min(8),
  password: z.string().min(10).max(256),
  timezone,
  user_label: z.string().trim().min(1).max(40).default("You"),
  ai_label: z.string().trim().min(1).max(40).default("AI")
});

export const loginSchema = z.object({
  password: z.string().min(1).max(256)
});

export const settingsSchema = z.object({
  timezone,
  user_label: z.string().trim().min(1).max(40),
  ai_label: z.string().trim().min(1).max(40),
  allowed_content: z.array(z.string().trim().min(1).max(120)).max(50),
  prohibited_content: z.array(z.string().trim().min(1).max(120)).max(50),
  punishment_intensity: z.number().int().min(0).max(5),
  daily_penalty_limit: z.number().int().min(0).max(100000),
  punishments_paused: z.boolean(),
  boundary_notes: z.string().trim().max(4000)
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type TaskQueryInput = z.infer<typeof taskQuerySchema>;
export type ManageTaskInput = z.infer<typeof manageTaskSchema>;
export type RewardManageInput = z.infer<typeof rewardManageSchema>;
export type AdjustPointsInput = z.infer<typeof adjustPointsSchema>;
