import fs from "node:fs";
import { parse } from "yaml";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const compose = parse(fs.readFileSync("docker-compose.yml", "utf8"));
const containerWorkflow = parse(fs.readFileSync(".github/workflows/container.yml", "utf8"));
const caddyfile = fs.readFileSync("deploy/Caddyfile", "utf8");
const dockerEnv = fs.readFileSync("docker.env.example", "utf8");
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
assert(!/ZEABUR/i.test(configSource), "Zeabur-specific configuration remains");
assert(!fs.existsSync("zeabur-template.yaml"), "The Zeabur template must not return after Zeabur's shutdown");
assert(
  !configSource.includes("PHOSPHENE_TIMEZONE") && !JSON.stringify(compose).includes("PHOSPHENE_TIMEZONE"),
  "Timezone must be selected in the website instead of duplicated as a deployment variable"
);
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

const services = compose.services ?? {};
assert(
  Object.keys(services).sort().join(",") === "app,caddy",
  "Compose must contain the app and the optional Caddy proxy only"
);
const app = services.app;
assert(app.image === "${PHOSPHENE_IMAGE:-phosphene:local}", "Compose must run the configured fork image");
assert(app.build?.context === ".", "Compose must keep building from source as a fallback");
assert(!app.profiles, "The app service must start without selecting a profile");
assert(app.mem_limit === "512m", "Compose must cap the app at 512 MiB so a leak cannot exhaust the host");
assert(
  app.ports?.length === 1 && app.ports[0] === "${PHOSPHENE_BIND:-127.0.0.1}:8080:8080",
  "Plain HTTP must only listen on the loopback interface unless explicitly changed"
);
assert(app.volumes?.includes("phosphene-data:/data"), "Compose /data volume is missing");
assert(
  app.environment.PHOSPHENE_SETUP_TOKEN.includes(":-"),
  "Compose must allow first-visitor setup when the optional Setup Token is omitted"
);
assert(
  app.environment.PHOSPHENE_MCP_AUTH_MODE.includes("token"),
  "Compose must keep token authentication as the default"
);

const caddy = services.caddy;
assert(caddy.profiles?.includes("https"), "Caddy must stay optional behind the https profile");
assert(
  ["80:80", "443:443"].every((port) => caddy.ports?.includes(port)),
  "Caddy must publish HTTP and HTTPS for certificate issuance and redirects"
);
assert(
  caddy.volumes?.includes("./deploy/Caddyfile:/etc/caddy/Caddyfile:ro") &&
    caddy.volumes.includes("caddy-data:/data"),
  "Caddy must load the bundled Caddyfile and persist its certificates"
);
assert(
  caddyfile.includes("{$PHOSPHENE_HOST} {") && caddyfile.includes("reverse_proxy app:8080"),
  "Caddy must proxy the configured host to the app"
);
assert(
  caddyfile.includes("profile shortlived") && caddyfile.includes("default_sni {$PHOSPHENE_HOST}"),
  "Caddy must be able to serve a public IP address without a domain"
);
assert(
  ["PHOSPHENE_IMAGE=", "PHOSPHENE_HOST=", "PHOSPHENE_SETUP_TOKEN="].every((key) => dockerEnv.includes(key)),
  "docker.env.example must document every Compose setting"
);

const metadata = containerWorkflow.jobs.publish.steps.find((step) => step.id === "meta");
assert(metadata?.with?.flavor?.includes("latest=false"), "latest must not be added automatically");
assert(
  metadata.with.tags.includes("type=raw,value=latest,enable=${{ startsWith(github.ref, 'refs/tags/v') }}"),
  "latest must only move when a version tag is published"
);
assert(
  metadata.with.tags.includes("type=ref,event=branch"),
  "Branch builds, including forks, must publish a branch tag such as main"
);
assert(containerWorkflow.on.workflow_dispatch !== undefined, "Forks must be able to start an image build manually");

console.log("Single-service SQLite deployment manifests are valid.");
