import path from "node:path";

export type DeploymentMode = "single" | "distributed";

type DeploymentInput = {
  nodeEnv: "development" | "test" | "production";
  databaseUrl?: string;
  storageDriver: "local" | "s3";
  dataDir?: string;
  pglitePath?: string;
  localStoragePath?: string;
  cwd?: string;
};

function isInside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isPgliteUrl(value: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

export function resolveDeployment(input: DeploymentInput) {
  const cwd = input.cwd ?? process.cwd();
  const defaultDataDir = input.nodeEnv === "production" ? "/data" : path.join(cwd, ".data");
  if (input.nodeEnv === "production" && input.dataDir && !path.isAbsolute(input.dataDir)) {
    throw new Error("PHOSPHENE_DATA_DIR must be an absolute path in production");
  }

  const dataDir = path.resolve(cwd, input.dataDir || defaultDataDir);
  const requestedPglitePath = input.pglitePath || path.join(dataDir, "phosphene");
  const pglitePath = isPgliteUrl(requestedPglitePath)
    ? requestedPglitePath
    : path.resolve(cwd, requestedPglitePath);
  const localStoragePath = path.resolve(
    cwd,
    input.localStoragePath || path.join(dataDir, "uploads")
  );
  const mode: DeploymentMode = input.databaseUrl ? "distributed" : "single";

  if (input.nodeEnv === "production") {
    if (mode === "distributed" && input.storageDriver !== "s3") {
      throw new Error("Distributed production mode requires STORAGE_DRIVER=s3");
    }
    if (mode === "single" && input.storageDriver !== "local") {
      throw new Error("Single-service production mode requires STORAGE_DRIVER=local");
    }
    if (mode === "single" && isPgliteUrl(pglitePath)) {
      throw new Error("Single-service production mode requires a persistent filesystem PGLITE_PATH");
    }
    if (
      mode === "single" &&
      (!isInside(dataDir, pglitePath) || !isInside(dataDir, localStoragePath))
    ) {
      throw new Error(
        "PGLITE_PATH and LOCAL_STORAGE_PATH must stay inside PHOSPHENE_DATA_DIR in single-service production mode"
      );
    }
  }

  return { mode, dataDir, pglitePath, localStoragePath };
}
