import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type SetupTokenSource = "development_default" | "environment" | "persistent_file" | "generated";

type ResolveSetupTokenInput = {
  nodeEnv: "development" | "test" | "production";
  dataDir: string;
  configuredToken?: string;
  randomSecret?: () => string;
};

const SETUP_TOKEN_FILE = ".phosphene-setup-token";
const MIN_PRODUCTION_TOKEN_LENGTH = 24;
const knownPlaceholders = new Set([
  "phosphene-local-setup",
  "change-this-before-production",
  "replace-with-a-long-random-value"
]);

function normalized(value?: string) {
  const token = value?.trim();
  return token || undefined;
}

function isSecureProductionToken(value?: string) {
  return Boolean(
    value &&
      value.length >= MIN_PRODUCTION_TOKEN_LENGTH &&
      !knownPlaceholders.has(value.toLowerCase())
  );
}

function readPersistedToken(filePath: string) {
  try {
    return normalized(fs.readFileSync(filePath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export function resolveSetupToken(input: ResolveSetupTokenInput) {
  const configuredToken = normalized(input.configuredToken);
  if (input.nodeEnv !== "production") {
    return {
      value: configuredToken ?? "phosphene-local-setup",
      source: configuredToken ? ("environment" as const) : ("development_default" as const),
      rejectedConfiguredToken: false,
      filePath: undefined
    };
  }

  if (isSecureProductionToken(configuredToken)) {
    return {
      value: configuredToken!,
      source: "environment" as const,
      rejectedConfiguredToken: false,
      filePath: undefined
    };
  }

  fs.mkdirSync(input.dataDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(input.dataDir, SETUP_TOKEN_FILE);
  const persistedToken = readPersistedToken(filePath);
  if (isSecureProductionToken(persistedToken)) {
    return {
      value: persistedToken!,
      source: "persistent_file" as const,
      rejectedConfiguredToken: Boolean(configuredToken),
      filePath
    };
  }

  const generatedToken = (input.randomSecret ?? (() => randomBytes(32).toString("base64url")))();
  if (!isSecureProductionToken(generatedToken)) {
    throw new Error("Generated setup token did not meet the production security requirements");
  }
  fs.writeFileSync(filePath, generatedToken, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return {
    value: generatedToken,
    source: "generated" as const,
    rejectedConfiguredToken: Boolean(configuredToken),
    filePath
  };
}
