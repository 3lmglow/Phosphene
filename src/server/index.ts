import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";
import { config } from "./config";
import { collectRuntimeGarbage, initializeDatabase, shutdownDatabase } from "./db/client";
import { seedDatabase } from "./db/seed";
import { handleMcp } from "./mcp";
import apiRouter, { apiErrorHandler } from "./routes";
import { requireAi } from "./services/auth";
import { getPublicSettings, reconcileSystem } from "./services/domain";
import { initializeStorage } from "./services/storage";

const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "response.headers['set-cookie']"
    ],
    censor: "[redacted]"
  }
});
const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy:
      config.NODE_ENV === "production"
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
              fontSrc: ["'self'", "https://fonts.gstatic.com"],
              imgSrc: ["'self'", "data:", "blob:"],
              connectSrc: ["'self'"],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"]
            }
          }
        : false,
    crossOriginResourcePolicy: { policy: "same-origin" }
  })
);
app.use(pinoHttp({ logger }));
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));

app.get("/healthz", (_request, response) => {
  response.json({ status: "ok", version: "1.0.0" });
});
app.use("/api", apiRouter);
app.use("/api", (_request, response) => {
  response.status(404).json({
    ok: false,
    error: { code: "api_not_found", message: "API route not found" }
  });
});
app.all("/mcp", requireAi, async (request, response, next) => {
  if (request.method !== "POST") {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null
    });
    return;
  }
  try {
    await handleMcp(request, response);
  } catch (error) {
    next(error);
  }
});

if (config.NODE_ENV === "development") {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
} else {
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
  app.use(express.static(webRoot, { index: false, maxAge: "1y", immutable: true }));
  app.use((_request, response) => {
    response.sendFile(path.join(webRoot, "index.html"));
  });
}

app.use(apiErrorHandler);

await initializeDatabase();
await initializeStorage();
await seedDatabase();
await reconcileSystem();
collectRuntimeGarbage();
const publicSettings = await getPublicSettings();
if (!publicSettings.initialized) {
  logger.warn(
    {
      setupMode: config.SETUP_PROTECTED ? "token_protected" : "first_visitor"
    },
    config.SETUP_PROTECTED
      ? "Phosphene is awaiting token-protected first-time setup."
      : "Phosphene is awaiting first-visitor setup. Initialize it before sharing the URL."
  );
}

const server = app.listen(config.PORT, () => {
  const memory = process.memoryUsage();
  logger.info(
    {
      port: config.PORT,
      url: config.PUBLIC_URL,
      deploymentMode: config.DEPLOYMENT_MODE,
      memoryRssMb: Math.round(memory.rss / 1024 / 1024),
      memoryExternalMb: Math.round(memory.external / 1024 / 1024),
      ...(config.DEPLOYMENT_MODE === "single" ? { dataDir: config.PHOSPHENE_DATA_DIR } : {})
    },
    "Phosphene is ready"
  );
});

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down Phosphene");
  server.close(async () => {
    await shutdownDatabase();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
