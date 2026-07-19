import argon2 from "argon2";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { CookieOptions, NextFunction, Request, Response } from "express";
import { config } from "../config";
import { getDb } from "../db/client";
import { aiTokens, appSettings, auditLogs, sessions, userAccount } from "../db/schema";
import { AppError, assertFound, assertState } from "../errors";
import { createId, createSecret, tokenHash } from "../lib/ids";

const SESSION_COOKIE = "phosphene_session";
const CSRF_COOKIE = "phosphene_csrf";
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;

const sessionCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: "strict",
  secure: config.NODE_ENV === "production",
  path: "/",
  maxAge: sessionLifetimeMs
};

const csrfCookieOptions: CookieOptions = {
  httpOnly: false,
  sameSite: "strict",
  secure: config.NODE_ENV === "production",
  path: "/",
  maxAge: sessionLifetimeMs
};

async function issueSession(response: Response, database: any = getDb()) {
  const rawToken = createSecret();
  const csrfToken = createSecret(24);
  const sessionId = createId("session");
  await database.insert(sessions).values({
    id: sessionId,
    tokenHash: tokenHash(rawToken),
    csrfTokenHash: tokenHash(csrfToken),
    expiresAt: new Date(Date.now() + sessionLifetimeMs)
  });
  response.cookie(SESSION_COOKIE, rawToken, sessionCookieOptions);
  response.cookie(CSRF_COOKIE, csrfToken, csrfCookieOptions);
  return { csrf_token: csrfToken };
}

export async function setupApplication(
  values: { setup_token: string; password: string; timezone: string; user_label: string; ai_label: string },
  response: Response
) {
  assertState(values.setup_token === config.PHOSPHENE_SETUP_TOKEN, "invalid_setup_token", "Setup token is invalid");
  const db = getDb();
  return db.transaction(async (tx: any) => {
    const settings = assertFound(await tx.query.appSettings.findFirst({ where: eq(appSettings.id, 1) }));
    assertState(!settings.initialized, "already_initialized", "Phosphene has already been set up");
    const passwordHash = await argon2.hash(values.password, { type: argon2.argon2id });
    await tx.insert(userAccount).values({ id: 1, passwordHash });
    await tx
      .update(appSettings)
      .set({
        initialized: true,
        timezone: values.timezone,
        userLabel: values.user_label,
        aiLabel: values.ai_label,
        updatedAt: new Date()
      })
      .where(eq(appSettings.id, 1));
    const aiToken = `phosphene_ai_${createSecret(32)}`;
    const aiTokenId = createId("aitoken");
    await tx.insert(aiTokens).values({
      id: aiTokenId,
      tokenHash: tokenHash(aiToken),
      name: "Primary AI"
    });
    await tx.insert(auditLogs).values({
      id: createId("audit"),
      actor: "user",
      action: "application.setup",
      entityType: "application",
      summary: "Phosphene initialized"
    });
    const session = await issueSession(response, tx);
    return {
      ...session,
      ai_token: aiToken,
      ai_token_id: aiTokenId,
      warning: "This AI token is shown once. Store it somewhere safe."
    };
  });
}

export async function login(password: string, response: Response) {
  const db = getDb();
  const account = assertFound(await db.query.userAccount.findFirst({ where: eq(userAccount.id, 1) }), "Account not initialized");
  const valid = await argon2.verify(account.passwordHash, password);
  if (!valid) throw new AppError(401, "invalid_credentials", "Password is incorrect");
  return issueSession(response);
}

export async function logout(request: Request, response: Response) {
  const raw = request.cookies?.[SESSION_COOKIE];
  if (raw) {
    await getDb()
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.tokenHash, tokenHash(raw)));
  }
  response.clearCookie(SESSION_COOKIE, { path: "/" });
  response.clearCookie(CSRF_COOKIE, { path: "/" });
}

export async function requireUser(request: Request, _response: Response, next: NextFunction) {
  try {
    const raw = request.cookies?.[SESSION_COOKIE];
    if (!raw) throw new AppError(401, "authentication_required", "Please sign in");
    const session = await getDb().query.sessions.findFirst({
      where: and(
        eq(sessions.tokenHash, tokenHash(raw)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date())
      )
    });
    if (!session) throw new AppError(401, "session_expired", "Your session has expired");
    request.phospheneSession = session;
    request.phospheneActor = "user";
    next();
  } catch (error) {
    next(error);
  }
}

export function requireCsrf(request: Request, _response: Response, next: NextFunction) {
  try {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
    const csrf = request.get("x-csrf-token");
    const cookie = request.cookies?.[CSRF_COOKIE];
    if (
      !csrf ||
      !cookie ||
      csrf !== cookie ||
      !request.phospheneSession ||
      tokenHash(csrf) !== request.phospheneSession.csrfTokenHash
    ) {
      throw new AppError(403, "csrf_failed", "Security token is missing or invalid");
    }
    next();
  } catch (error) {
    next(error);
  }
}

export async function requireAi(request: Request, _response: Response, next: NextFunction) {
  try {
    const authorization = request.get("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new AppError(401, "ai_token_required", "AI bearer token is required");
    const raw = authorization.slice(7);
    const token = await getDb().query.aiTokens.findFirst({
      where: and(eq(aiTokens.tokenHash, tokenHash(raw)), isNull(aiTokens.revokedAt))
    });
    if (!token) throw new AppError(401, "invalid_ai_token", "AI token is invalid or revoked");
    await getDb().update(aiTokens).set({ lastUsedAt: new Date() }).where(eq(aiTokens.id, token.id));
    request.phospheneActor = "AI";
    next();
  } catch (error) {
    next(error);
  }
}

export async function rotateAiToken(name = "Primary AI") {
  const db = getDb();
  return db.transaction(async (tx: any) => {
    await tx.update(aiTokens).set({ revokedAt: new Date() }).where(isNull(aiTokens.revokedAt));
    const raw = `phosphene_ai_${createSecret(32)}`;
    const id = createId("aitoken");
    await tx.insert(aiTokens).values({ id, name, tokenHash: tokenHash(raw) });
    await tx.insert(auditLogs).values({
      id: createId("audit"),
      actor: "user",
      action: "ai_token.rotated",
      entityType: "ai_token",
      entityId: id,
      summary: "AI access token rotated"
    });
    return { id, token: raw, warning: "This token is shown once." };
  });
}

export async function listAiTokens() {
  return getDb().query.aiTokens.findMany({
    columns: { id: true, name: true, createdAt: true, lastUsedAt: true, revokedAt: true }
  });
}

export async function changePassword(currentPassword: string, newPassword: string) {
  const db = getDb();
  const account = assertFound(await db.query.userAccount.findFirst({ where: eq(userAccount.id, 1) }));
  if (!(await argon2.verify(account.passwordHash, currentPassword))) {
    throw new AppError(401, "invalid_credentials", "Current password is incorrect");
  }
  const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
  await db.transaction(async (tx: any) => {
    await tx.update(userAccount).set({ passwordHash, passwordChangedAt: new Date(), updatedAt: new Date() }).where(eq(userAccount.id, 1));
    await tx.update(sessions).set({ revokedAt: new Date() }).where(isNull(sessions.revokedAt));
  });
}

export async function verifyPassword(password: string): Promise<void> {
  const account = assertFound(
    await getDb().query.userAccount.findFirst({ where: eq(userAccount.id, 1) }),
    "Account not initialized"
  );
  if (!(await argon2.verify(account.passwordHash, password))) {
    throw new AppError(401, "invalid_credentials", "Password is incorrect");
  }
}
