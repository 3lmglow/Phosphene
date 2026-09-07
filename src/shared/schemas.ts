import { z } from "zod";
import { recoveryAnswerSchema, recoveryQuestionSchema } from "./recovery";
import {
  PROOF_REQUIREMENTS,
  RECURRENCE_MODES,
  REVEAL_MODES,
  TASK_DIFFICULTIES,
  TASK_STATUSES,
  WEBHOOK_EVENT_TYPES,
  TASK_TYPES,
  VERIFICATION_MODES
} from "./constants";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "必须使用 YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, "日期无效");
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
    if (value.recurrence === "daily" && value.reveal_mode !== "immediate") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reveal_mode"],
        message: "每日重复任务固定立即展示，不支持延迟揭晓"
      });
    }
    if (value.recurrence === "once" && (value.start_date || value.end_date)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [value.start_date ? "start_date" : "end_date"],
        message: "一次性任务不能设置重复系列的开始或结束日期"
      });
    }
    if (value.reveal_mode === "at_time" && !value.visible_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["visible_at"],
        message: "定时揭晓必须提供 visible_at"
      });
    }
    if (value.reveal_mode !== "at_time" && value.visible_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["visible_at"],
        message: "只有定时揭晓任务可以提供 visible_at"
      });
    }
    if (
      value.visible_at &&
      value.deadline &&
      new Date(value.visible_at).valueOf() >= new Date(value.deadline).valueOf()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["visible_at"],
        message: "任务必须在截止时间之前揭晓"
      });
    }
  });

const timestampCursorSchema = z.string().datetime({ offset: true });
export const paginationCursorSchema = z.string().max(512).refine(
  (value) => timestampCursorSchema.safeParse(value).success || /^pc_[A-Za-z0-9_-]+$/.test(value),
  "分页 cursor 无效"
);

export const taskQuerySchema = z.object({
  task_id: z.string().optional(),
  status: z.enum([...TASK_STATUSES, "active"]).optional(),
  type: z.enum(TASK_TYPES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  include_proof: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(30),
  cursor: paginationCursorSchema.optional()
});

export const manageTaskSchema = z
  .discriminatedUnion("action", [
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
  ])
  .superRefine((value, context) => {
    if (value.action === "review" && value.decision === "reject" && !value.reason?.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "打回提交时必须说明理由，让 user 知道需要补充或修改什么"
      });
    }
  });

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
  z.object({
    action: z.literal("restore"),
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

export const PASSWORD_REQUIREMENTS = "仅支持大小写英文字母、数字和半角符号，可只用其中一类或任意组合；不允许空格、中文、全角符号或不可见字符。请使用英文输入法。";
export const PASSWORD_CHARACTER_ERROR = "密码含有不支持的字符。请使用英文输入法，只输入大小写英文字母、数字或半角符号，不要包含空格、中文、全角符号或不可见字符。";

export const newPasswordSchema = z.string()
  .min(10, "密码至少需要 10 个字符。")
  .max(256, "密码不能超过 256 个字符。")
  // Reject every character outside visible ASCII, including trailing line breaks.
  .refine((value) => !/[^\x21-\x7E]/.test(value), PASSWORD_CHARACTER_ERROR);

export const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(256),
  new_password: newPasswordSchema
});

export const resetPasswordSchema = z.object({
  answer: recoveryAnswerSchema,
  new_password: newPasswordSchema
});

export const recoverySettingsSchema = z.object({
  current_password: z.string().min(1).max(256),
  recovery: recoveryQuestionSchema.nullable()
});

export const setupSchema = z.object({
  setup_token: z.string().max(512).optional().default(""),
  password: newPasswordSchema,
  recovery: recoveryQuestionSchema.optional(),
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

const webhookUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    try {
      const parsed = new URL(value);
      return (
        ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  }, "Webhook URL 必须使用 http:// 或 https://，且不能包含账号、密码或 fragment");

export const webhookSettingsSchema = z
  .object({
    enabled: z.boolean(),
    url: webhookUrl,
    event_types: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length)
  })
  .superRefine((value, context) => {
    if (value.enabled && !value.url) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "启用 Webhook 前必须填写接收地址"
      });
    }
  });

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type TaskQueryInput = z.infer<typeof taskQuerySchema>;
export type ManageTaskInput = z.infer<typeof manageTaskSchema>;
export type RewardManageInput = z.infer<typeof rewardManageSchema>;
export type AdjustPointsInput = z.infer<typeof adjustPointsSchema>;
export type WebhookSettingsInput = z.infer<typeof webhookSettingsSchema>;
