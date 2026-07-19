import { z } from "zod";
import { resolveDeployment } from "./lib/deployment";

try {
  process.loadEnvFile?.(".env");
} catch {
  // .env is optional; production values are injected by Zeabur.
}

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalString = z.preprocess(blankToUndefined, z.string().optional());
const optionalUrl = z.preprocess(
  blankToUndefined,
  z.string().url().optional()
);
const stringWithDefault = (fallback: string) =>
  z.preprocess(blankToUndefined, z.string().default(fallback));
const urlWithDefault = (fallback: string) =>
  z.preprocess(blankToUndefined, z.string().url().default(fallback));

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: optionalUrl,
  ZEABUR_WEB_URL: optionalUrl,
  PHOSPHENE_SETUP_TOKEN: optionalString,
  PHOSPHENE_TIMEZONE: z.string().default("Asia/Shanghai"),
  PHOSPHENE_DATA_DIR: optionalString,
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: optionalString,
  PGLITE_PATH: optionalString,
  PGLITE_INITIAL_MEMORY_MB: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(128).max(512).default(128)
  ),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  LOCAL_STORAGE_PATH: optionalString,
  S3_ENDPOINT: urlWithDefault("http://localhost:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("phosphene-proofs"),
  S3_ACCESS_KEY: stringWithDefault("phosphene"),
  S3_SECRET_KEY: stringWithDefault("phosphene-local-secret"),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default("true")
    .transform((value) => value === "true")
});

const parsed = configSchema.parse(process.env);
const deployment = resolveDeployment({
  nodeEnv: parsed.NODE_ENV,
  databaseUrl: parsed.DATABASE_URL,
  storageDriver: parsed.STORAGE_DRIVER,
  dataDir: parsed.PHOSPHENE_DATA_DIR,
  pglitePath: parsed.PGLITE_PATH,
  localStoragePath: parsed.LOCAL_STORAGE_PATH
});
const publicUrl = parsed.PUBLIC_URL ?? parsed.ZEABUR_WEB_URL ?? `http://localhost:${parsed.PORT}`;

export const config = {
  ...parsed,
  PUBLIC_URL: publicUrl,
  PHOSPHENE_DATA_DIR: deployment.dataDir,
  PGLITE_PATH: deployment.pglitePath,
  LOCAL_STORAGE_PATH: deployment.localStoragePath,
  DEPLOYMENT_MODE: deployment.mode,
  SETUP_PROTECTED: Boolean(parsed.PHOSPHENE_SETUP_TOKEN)
};
