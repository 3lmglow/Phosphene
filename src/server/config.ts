import path from "node:path";
import { z } from "zod";

try {
  process.loadEnvFile?.(".env");
} catch {
  // .env is optional; production values are injected by Zeabur.
}

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  PHOSPHENE_SETUP_TOKEN: z.string().min(8).default("phosphene-local-setup"),
  PHOSPHENE_TIMEZONE: z.string().default("Asia/Shanghai"),
  SESSION_SECRET: z.string().min(16).default("local-development-session-secret"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().optional(),
  PGLITE_PATH: z.string().default(path.resolve(".data/phosphene")),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  LOCAL_STORAGE_PATH: z.string().default(path.resolve(".data/uploads")),
  S3_ENDPOINT: z.string().url().default("http://localhost:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("phosphene-proofs"),
  S3_ACCESS_KEY: z.string().default("phosphene"),
  S3_SECRET_KEY: z.string().default("phosphene-local-secret"),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default("true")
    .transform((value) => value === "true")
});

export const config = configSchema.parse(process.env);

if (config.NODE_ENV === "production") {
  if (
    config.PHOSPHENE_SETUP_TOKEN === "phosphene-local-setup" ||
    config.PHOSPHENE_SETUP_TOKEN.length < 24
  ) {
    throw new Error("PHOSPHENE_SETUP_TOKEN must contain at least 24 characters in production");
  }
  if (
    config.SESSION_SECRET === "local-development-session-secret" ||
    config.SESSION_SECRET.length < 32
  ) {
    throw new Error("SESSION_SECRET must contain at least 32 characters in production");
  }
  if (!config.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production");
  }
  if (config.STORAGE_DRIVER !== "s3") {
    throw new Error("Production requires STORAGE_DRIVER=s3");
  }
}
