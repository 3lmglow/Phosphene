import { z } from "zod";

export const RECOVERY_NOTICE = "问题和答案由你自由填写；知道答案的人也能重置密码。";
export const RECOVERY_ANSWER_HINT = "支持中文，区分大小写，忽略首尾空格。";

export const recoveryAnswerSchema = z.string().trim()
  .min(1, "请输入密保答案。")
  .max(256, "密保答案不能超过 256 个字符。");

export const recoveryQuestionSchema = z.object({
  question: z.string().trim().min(1, "请输入密保问题。").max(200, "密保问题不能超过 200 个字符。"),
  answer: recoveryAnswerSchema
});

export type RecoveryQuestion = z.infer<typeof recoveryQuestionSchema>;
export type RecoveryStatus = { enabled: boolean; question: string | null };
