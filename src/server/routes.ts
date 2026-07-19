import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import { MAX_PROOF_IMAGE_BYTES, MAX_PROOF_IMAGES } from "../shared/constants";
import {
  loginSchema,
  settingsSchema,
  setupSchema,
  submitTaskSchema,
  taskQuerySchema
} from "../shared/schemas";
import { config } from "./config";
import { getDb } from "./db/client";
import { proofAssets } from "./db/schema";
import { AppError, assertFound } from "./errors";
import { createId } from "./lib/ids";
import {
  changePassword,
  listAiTokens,
  login,
  logout,
  requireCsrf,
  requireUser,
  rotateAiToken,
  setupApplication,
  verifyPassword
} from "./services/auth";
import {
  MAX_BACKUP_ARCHIVE_BYTES,
  restoreBackupFromFile,
  streamBackup
} from "./services/backup";
import {
  getOverview,
  getPublicSettings,
  getUserSettings,
  listAchievements,
  manageRewards,
  queryHistory,
  queryTasks,
  redeemReward,
  revealNextVisitTasks,
  submitTask,
  updateUserSettings
} from "./services/domain";
import { getObject, removeStoredProofs, saveProofImages } from "./services/storage";

const router = Router();
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PROOF_IMAGE_BYTES, files: MAX_PROOF_IMAGES, fields: 10 }
});
const backupUpload = multer({
  storage: multer.diskStorage({
    destination: config.BACKUP_TEMP_PATH,
    filename: (_request, _file, callback) => {
      callback(null, `${createId("backup_upload")}.zip`);
    }
  }),
  limits: { fileSize: MAX_BACKUP_ARCHIVE_BYTES, files: 1, fields: 3 }
});

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>
) {
  return (request: Request, response: Response, next: NextFunction) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function routeParam(request: Request, name: string): string {
  const value = request.params[name];
  if (Array.isArray(value) || !value) throw new AppError(400, "invalid_route", `Missing route parameter: ${name}`);
  return value;
}

router.get(
  "/bootstrap",
  asyncRoute(async (_request, response) => {
    response.json({ ok: true, data: await getPublicSettings() });
  })
);

router.post(
  "/setup",
  authLimiter,
  asyncRoute(async (request, response) => {
    const input = setupSchema.parse(request.body);
    response.status(201).json({ ok: true, data: await setupApplication(input, response) });
  })
);

router.post(
  "/login",
  authLimiter,
  asyncRoute(async (request, response) => {
    const input = loginSchema.parse(request.body);
    response.json({ ok: true, data: await login(input.password, response) });
  })
);

router.use(requireUser);
router.use(
  asyncRoute(async (request, _response, next) => {
    if (request.method === "GET") await revealNextVisitTasks();
    next();
  })
);
router.use(requireCsrf);

router.get("/me", (_request, response) => {
  response.json({ ok: true, data: { authenticated: true } });
});

router.post(
  "/logout",
  asyncRoute(async (request, response) => {
    await logout(request, response);
    response.json({ ok: true });
  })
);

router.get(
  "/overview",
  asyncRoute(async (_request, response) => {
    response.json({ ok: true, data: await getOverview() });
  })
);

router.get(
  "/tasks",
  asyncRoute(async (request, response) => {
    const input = taskQuerySchema.parse({
      task_id: request.query.task_id,
      status: request.query.status,
      type: request.query.type,
      from: request.query.from,
      to: request.query.to,
      include_proof: request.query.include_proof === "true",
      limit: request.query.limit ? Number(request.query.limit) : 50,
      cursor: request.query.cursor
    });
    response.json({ ok: true, data: await queryTasks(input, "user") });
  })
);

router.get(
  "/tasks/:taskId",
  asyncRoute(async (request, response) => {
    const data = await queryTasks(
      {
        task_id: routeParam(request, "taskId"),
        include_proof: true,
        limit: 1
      },
      "user"
    );
    response.json({ ok: true, data: assertFound(data.items[0], "Task not found") });
  })
);

router.post(
  "/tasks/:taskId/submit",
  upload.array("images", MAX_PROOF_IMAGES),
  asyncRoute(async (request, response) => {
    const input = submitTaskSchema.parse(request.body);
    const files = (request.files ?? []) as Express.Multer.File[];
    const stored = await saveProofImages(files);
    try {
      const result = await submitTask(routeParam(request, "taskId"), input.proof_text, stored, "user");
      response.status(201).json({ ok: true, data: result });
    } catch (error) {
      await removeStoredProofs(stored);
      throw error;
    }
  })
);

router.get(
  "/proofs/:assetId",
  asyncRoute(async (request, response) => {
    const asset = assertFound(
      await getDb().query.proofAssets.findFirst({ where: eq(proofAssets.id, routeParam(request, "assetId")) }),
      "Proof image not found"
    );
    const original = request.query.variant === "original";
    const buffer = await getObject(original ? asset.objectKey : asset.previewKey);
    response.set({
      "Content-Type": asset.mimeType,
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff"
    });
    response.send(buffer);
  })
);

router.get(
  "/rewards",
  asyncRoute(async (_request, response) => {
    response.json({
      ok: true,
      data: await manageRewards({ action: "list", include_archived: false }, "user")
    });
  })
);

router.post(
  "/rewards/:rewardId/redeem",
  asyncRoute(async (request, response) => {
    const body = z.object({ idempotency_key: z.string().min(8).max(128) }).parse(request.body);
    response.status(201).json({
      ok: true,
      data: await redeemReward(routeParam(request, "rewardId"), body.idempotency_key)
    });
  })
);

router.get(
  "/redemptions",
  asyncRoute(async (_request, response) => {
    response.json({
      ok: true,
      data: await manageRewards({ action: "list_redemptions" }, "user")
    });
  })
);

router.get(
  "/achievements",
  asyncRoute(async (_request, response) => {
    response.json({ ok: true, data: await listAchievements() });
  })
);

router.get(
  "/history",
  asyncRoute(async (request, response) => {
    const kind = z.enum(["all", "tasks", "points", "redemptions", "audit"]).default("all").parse(request.query.kind);
    const limit = z.coerce.number().int().min(1).max(100).default(50).parse(request.query.limit);
    response.json({ ok: true, data: await queryHistory({ kind, limit }) });
  })
);

router.get(
  "/settings",
  asyncRoute(async (_request, response) => {
    response.json({ ok: true, data: await getUserSettings() });
  })
);

router.put(
  "/settings",
  asyncRoute(async (request, response) => {
    response.json({ ok: true, data: await updateUserSettings(settingsSchema.parse(request.body)) });
  })
);

router.get(
  "/backup/export",
  asyncRoute(async (_request, response) => {
    const stamp = new Date().toISOString().slice(0, 10);
    response.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="phosphene-backup-${stamp}.zip"`,
      "Cache-Control": "no-store"
    });
    try {
      await streamBackup(response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      throw error;
    }
  })
);

router.post(
  "/backup/restore",
  backupUpload.single("backup"),
  asyncRoute(async (request, response) => {
    if (!request.file) throw new AppError(400, "backup_required", "Select a backup file");
    const uploadPath = path.resolve(request.file.path);
    try {
      const password = z.string().min(1).max(256).parse(request.body.password);
      await verifyPassword(password);
      await restoreBackupFromFile(uploadPath);
      response.json({ ok: true, data: { restored: true, login_required: false } });
    } finally {
      await fs.rm(uploadPath, { force: true });
    }
  })
);

router.get(
  "/ai-tokens",
  asyncRoute(async (_request, response) => {
    response.json({ ok: true, data: await listAiTokens() });
  })
);

router.post(
  "/ai-tokens/rotate",
  asyncRoute(async (request, response) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80).default("Primary AI") }).parse(request.body);
    response.status(201).json({ ok: true, data: await rotateAiToken(name) });
  })
);

router.put(
  "/password",
  authLimiter,
  asyncRoute(async (request, response) => {
    const input = z
      .object({
        current_password: z.string().min(1).max(256),
        new_password: z.string().min(10).max(256)
      })
      .parse(request.body);
    await changePassword(input.current_password, input.new_password);
    response.json({ ok: true, data: { login_required: true } });
  })
);

export function apiErrorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction) {
  if (error instanceof z.ZodError) {
    response.status(400).json({
      ok: false,
      error: { code: "validation_error", message: "The request contains invalid values", details: error.flatten() }
    });
    return;
  }
  if (error instanceof multer.MulterError) {
    response.status(413).json({
      ok: false,
      error: { code: "upload_error", message: error.message }
    });
    return;
  }
  if (error instanceof AppError) {
    response.status(error.status).json({
      ok: false,
      error: { code: error.code, message: error.message, details: error.details }
    });
    return;
  }
  console.error(error);
  response.status(500).json({
    ok: false,
    error: { code: "internal_error", message: "Phosphene encountered an unexpected error" }
  });
}

export default router;
