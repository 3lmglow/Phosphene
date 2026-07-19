import fs from "node:fs";
import { parse } from "yaml";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const zeabur = parse(fs.readFileSync("zeabur-template.yaml", "utf8"));
const compose = parse(fs.readFileSync("docker-compose.yml", "utf8"));
const dockerfile = fs.readFileSync("Dockerfile", "utf8");
const entrypoint = fs.readFileSync("docker-entrypoint.sh", "utf8");
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const configSource = fs.readFileSync("src/server/config.ts", "utf8");
const databaseSource = fs.readFileSync("src/server/db/client.ts", "utf8");
const storageSource = fs.readFileSync("src/server/services/storage.ts", "utf8");
const serverSource = fs.readFileSync("src/server/index.ts", "utf8");
const manifest = JSON.parse(fs.readFileSync("public/manifest.webmanifest", "utf8"));
const serviceWorker = fs.readFileSync("public/sw.js", "utf8");

assert(dockerfile.includes('VOLUME ["/data"]'), "Image must declare the /data volume");
assert(dockerfile.includes("docker-entrypoint.sh"), "Image must install its entrypoint");
assert(
  dockerfile.includes("--max-old-space-size=128") &&
    dockerfile.includes("--max-semi-space-size=4") &&
    !dockerfile.includes("--expose-gc"),
  "Image must bound the Node heap without relying on explicit garbage collection"
);
assert(entrypoint.includes('PHOSPHENE_DATA_DIR:-/data'), "Entrypoint must default to /data");
assert(entrypoint.includes('exec gosu node "$@"'), "Entrypoint must drop privileges before starting");
assert(
  entrypoint.includes('if ! chown node:node "$data_dir"') &&
    entrypoint.includes('gosu node test -w "$data_dir"'),
  "Entrypoint must tolerate root-squashed volumes while verifying node write access"
);

assert(packageJson.dependencies["@libsql/client"], "Embedded SQLite driver is missing");
for (const removed of ["@aws-sdk/client-s3", "@electric-sql/pglite", "pg"]) {
  assert(!(removed in packageJson.dependencies), `Removed distributed dependency remains: ${removed}`);
}
assert(configSource.includes("SQLITE_PATH"), "SQLite path configuration is missing");
assert(!/DATABASE_URL|PGLITE|S3_|STORAGE_DRIVER/.test(configSource), "Legacy storage configuration remains");
assert(databaseSource.includes('PRAGMA journal_mode = WAL'), "SQLite WAL mode is not enabled");
assert(databaseSource.includes('PRAGMA foreign_keys = ON'), "SQLite foreign keys are not enabled");
assert(!/@electric-sql|node-postgres/.test(databaseSource), "Legacy database driver remains");
assert(!/@aws-sdk|S3Client/.test(storageSource), "Legacy object storage driver remains");
assert(manifest.display === "standalone", "PWA must open in standalone mode");
assert(manifest.icons.some((icon) => icon.sizes === "512x512"), "PWA 512px icon is missing");
assert(
  serviceWorker.includes('url.pathname.startsWith("/api/")') &&
    serviceWorker.includes('url.pathname === "/mcp"'),
  "Service worker must not cache private API or MCP traffic"
);
assert(
  serverSource.includes('["sw.js", "manifest.webmanifest"]') &&
    serverSource.includes('response.setHeader("Cache-Control", "no-cache")'),
  "Service worker and manifest must remain revalidatable after deployment updates"
);

assert(zeabur.apiVersion === "zeabur.com/v1", "Unexpected Zeabur apiVersion");
assert(zeabur.kind === "Template", "Zeabur resource must be a Template");
assert(zeabur.spec?.services?.length === 1, "Zeabur template must deploy exactly one service");
const app = zeabur.spec.services[0];
assert(app.name === "phosphene", "Zeabur service name is incorrect");
assert(app.domainKey === "PUBLIC_DOMAIN", "Phosphene domain is not wired");
assert(app.spec.source.image === "ghcr.io/3lmglow/phosphene:latest", "Zeabur image is incorrect");
assert(app.spec.ports.some((port) => port.id === "web" && port.port === 8080), "Web port 8080 is missing");
assert(app.spec.volumes.some((volume) => volume.dir === "/data"), "Zeabur /data volume is missing");
assert(!app.dependencies, "Single-service template must not declare service dependencies");

assert(Object.keys(compose.services ?? {}).length === 1, "Compose must contain exactly one service");
assert(compose.services?.app, "Compose app service is missing");
assert(
  compose.services.app.volumes.includes("phosphene-data:/data"),
  "Compose /data volume is missing"
);
assert(
  compose.services.app.environment.PHOSPHENE_SETUP_TOKEN.includes(":-"),
  "Compose must allow first-visitor setup when the optional Setup Token is omitted"
);
assert(
  compose.services.app.environment.PHOSPHENE_MCP_AUTH_MODE.includes("token"),
  "Compose must keep token authentication as the default"
);
assert(
  app.spec.env.PHOSPHENE_MCP_AUTH_MODE.default === "token",
  "Zeabur must keep token authentication as the default"
);

console.log("Single-service SQLite deployment manifests are valid.");
