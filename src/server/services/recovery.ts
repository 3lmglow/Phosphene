import argon2 from "argon2";
import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { RecoveryStatus } from "../../shared/recovery";
import { recoverySettingsSchema, resetPasswordSchema } from "../../shared/schemas";
import { getDb, runTransaction } from "../db/client";
import { auditLogs, sessions, userAccount } from "../db/schema";
import { AppError, assertFound, assertState } from "../errors";
import { createId } from "../lib/ids";

const attemptLimit = 5;
const attemptWindowMs = 15 * 60 * 1000;

export async function getRecoveryStatus(): Promise<RecoveryStatus> {
  const account = await getDb().query.userAccount.findFirst({
    columns: { recoveryQuestion: true, recoveryAnswerHash: true },
    where: eq(userAccount.id, 1)
  });
  const enabled = Boolean(account?.recoveryQuestion && account.recoveryAnswerHash);
  return { enabled, question: enabled ? account!.recoveryQuestion : null };
}

export async function saveRecoverySettings(values: unknown) {
  const input = recoverySettingsSchema.parse(values);
  const db = getDb();
  const account = assertFound(await db.query.userAccount.findFirst({ where: eq(userAccount.id, 1) }));
  if (!(await argon2.verify(account.passwordHash, input.current_password))) {
    throw new AppError(401, "invalid_credentials", "当前密码不正确。");
  }
  const recoveryAnswerHash = input.recovery
    ? await argon2.hash(input.recovery.answer, { type: argon2.argon2id }) : null;
  await runTransaction(async (tx: any) => {
    const [updated] = await tx.update(userAccount).set({
      recoveryQuestion: input.recovery?.question ?? null,
      recoveryAnswerHash,
      recoveryAttempts: 0,
      recoveryWindowStartedAt: null,
      updatedAt: new Date()
    }).where(and(
      eq(userAccount.id, 1), eq(userAccount.passwordHash, account.passwordHash),
      account.recoveryAnswerHash ? eq(userAccount.recoveryAnswerHash, account.recoveryAnswerHash) : isNull(userAccount.recoveryAnswerHash)
    )).returning({ id: userAccount.id });
    assertState(updated, "credentials_changed", "密码或密保已变化，请刷新后再试。");
    await tx.insert(auditLogs).values({
      id: createId("audit"), actor: "user", action: input.recovery ? "recovery.updated" : "recovery.disabled",
      entityType: "application", summary: input.recovery ? "Password recovery configured" : "Password recovery disabled"
    });
  });
  return getRecoveryStatus();
}

export async function resetPasswordWithRecovery(values: unknown) {
  const input = resetPasswordSchema.parse(values);
  const db = getDb();
  const account = await db.query.userAccount.findFirst({ where: eq(userAccount.id, 1) });
  if (!account?.recoveryAnswerHash || !account.recoveryQuestion) {
    throw new AppError(400, "recovery_not_configured", "此实例没有设置密保，暂时无法通过密保找回密码。");
  }
  const now = new Date();
  const cutoff = new Date(now.valueOf() - attemptWindowMs);
  const expired = or(isNull(userAccount.recoveryWindowStartedAt), lte(userAccount.recoveryWindowStartedAt, cutoff));
  const unchanged = and(eq(userAccount.id, 1), eq(userAccount.passwordHash, account.passwordHash), eq(userAccount.recoveryAnswerHash, account.recoveryAnswerHash));
  // Reserve an attempt atomically before hashing. This limit survives restarts and
  // applies to the single account even when requests arrive from different IPs.
  const [reserved] = await runTransaction((tx) => tx.update(userAccount).set({
    recoveryAttempts: sql`case when ${expired} then 1 else ${userAccount.recoveryAttempts} + 1 end`,
    recoveryWindowStartedAt: sql`case when ${expired} then ${now.valueOf()} else ${userAccount.recoveryWindowStartedAt} end`
  }).where(and(unchanged, or(expired, lt(userAccount.recoveryAttempts, attemptLimit)))).returning({ id: userAccount.id }));
  if (!reserved) {
    throw new AppError(429, "recovery_rate_limited", "密保尝试次数过多，请 15 分钟后再试。你仍可以使用原密码登录。");
  }
  if (!(await argon2.verify(account.recoveryAnswerHash, input.answer))) {
    throw new AppError(401, "invalid_recovery_answer", "密保答案不正确，请检查大小写后重试。");
  }
  const passwordHash = await argon2.hash(input.new_password, { type: argon2.argon2id });
  await runTransaction(async (tx: any) => {
    const [updated] = await tx.update(userAccount).set({
      passwordHash, passwordChangedAt: new Date(), updatedAt: new Date(),
      recoveryAttempts: 0, recoveryWindowStartedAt: null
    }).where(unchanged).returning({ id: userAccount.id });
    assertState(updated, "credentials_changed", "密码或密保已变化，请刷新后再试。");
    await tx.update(sessions).set({ revokedAt: new Date() }).where(isNull(sessions.revokedAt));
    await tx.insert(auditLogs).values({
      id: createId("audit"), actor: "user", action: "password.recovered",
      entityType: "application", summary: "Password reset using recovery answer"
    });
  });
}
