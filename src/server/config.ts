import { z } from "zod";
import { resolveDeployment } from "./lib/deployment";
import { MCP_AUTH_MODES } from "./lib/mcp-connection";

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

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: optionalUrl,
  ZEABUR_WEB_URL: optionalUrl,
  PHOSPHENE_SETUP_TOKEN: optionalString,
  PHOSPHENE_MCP_AUTH_MODE: z.preprocess(
    blankToUndefined,
    z.enum(MCP_AUTH_MODES).default("token")
  ),
  PHOSPHENE_DATA_DIR: optionalString,
  LOG_LEVEL: z.string().default("info"),
  SQLITE_PATH: optionalString,
  LOCAL_STORAGE_PATH: optionalString
});

const parsed = configSchema.parse(process.env);
const deployment = resolveDeployment({
  nodeEnv: parsed.NODE_ENV,
  dataDir: parsed.PHOSPHENE_DATA_DIR,
  sqlitePath: parsed.SQLITE_PATH,
  localStoragePath: parsed.LOCAL_STORAGE_PATH
});
const publicUrl = parsed.PUBLIC_URL ?? parsed.ZEABUR_WEB_URL ?? `http://localhost:${parsed.PORT}`;

export const config = {
  ...parsed,
  PUBLIC_URL: publicUrl,
  PHOSPHENE_DATA_DIR: deployment.dataDir,
  SQLITE_PATH: deployment.sqlitePath,
  LOCAL_STORAGE_PATH: deployment.localStoragePath,
  DEPLOYMENT_MODE: deployment.mode,
  SETUP_PROTECTED: Boolean(parsed.PHOSPHENE_SETUP_TOKEN)
};
