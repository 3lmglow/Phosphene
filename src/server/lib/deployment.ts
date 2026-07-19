import path from "node:path";

type DeploymentInput = {
  nodeEnv: "development" | "test" | "production";
  dataDir?: string;
  sqlitePath?: string;
  localStoragePath?: string;
  cwd?: string;
};

function isInside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveDeployment(input: DeploymentInput) {
  const cwd = input.cwd ?? process.cwd();
  const defaultDataDir = input.nodeEnv === "production" ? "/data" : path.join(cwd, ".data");
  if (input.nodeEnv === "production" && input.dataDir && !path.isAbsolute(input.dataDir)) {
    throw new Error("PHOSPHENE_DATA_DIR must be an absolute path in production");
  }

  const dataDir = path.resolve(cwd, input.dataDir || defaultDataDir);
  const requestedSqlitePath = input.sqlitePath || path.join(dataDir, "phosphene.sqlite");
  const sqlitePath =
    requestedSqlitePath === ":memory:"
      ? requestedSqlitePath
      : path.resolve(cwd, requestedSqlitePath);
  const localStoragePath = path.resolve(
    cwd,
    input.localStoragePath || path.join(dataDir, "uploads")
  );
  const backupTempPath = path.join(dataDir, "tmp");

  if (input.nodeEnv === "production") {
    if (sqlitePath === ":memory:") {
      throw new Error("Production requires a persistent filesystem SQLITE_PATH");
    }
    if (!isInside(dataDir, sqlitePath) || !isInside(dataDir, localStoragePath)) {
      throw new Error(
        "SQLITE_PATH and LOCAL_STORAGE_PATH must stay inside PHOSPHENE_DATA_DIR in production"
      );
    }
  }

  return {
    mode: "single" as const,
    dataDir,
    sqlitePath,
    localStoragePath,
    backupTempPath
  };
}
