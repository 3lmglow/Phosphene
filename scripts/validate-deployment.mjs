import fs from "node:fs";
import { parse } from "yaml";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const zeabur = parse(fs.readFileSync("zeabur-template.yaml", "utf8"));
const compose = parse(fs.readFileSync("docker-compose.yml", "utf8"));
const minioDockerfile = fs.readFileSync("infra/minio/Dockerfile", "utf8");
const appDockerfile = fs.readFileSync("Dockerfile", "utf8");
const entrypoint = fs.readFileSync("docker-entrypoint.sh", "utf8");

assert(appDockerfile.includes('VOLUME ["/data"]'), "Single-service image must declare the /data volume");
assert(appDockerfile.includes("docker-entrypoint.sh"), "Single-service image must install its entrypoint");
assert(entrypoint.includes('PHOSPHENE_DATA_DIR:-/data'), "Entrypoint must default to /data");
assert(entrypoint.includes('exec gosu node "$@"'), "Entrypoint must drop privileges before starting");

assert(zeabur.apiVersion === "zeabur.com/v1", "Unexpected Zeabur apiVersion");
assert(zeabur.kind === "Template", "Zeabur resource must be a Template");
assert(Array.isArray(zeabur.spec?.services), "Zeabur services are missing");

const services = new Map(zeabur.spec.services.map((service) => [service.name, service]));
for (const name of ["phosphene", "postgresql", "minio"]) {
  assert(services.has(name), `Zeabur service is missing: ${name}`);
}
const app = services.get("phosphene");
const minio = services.get("minio");
assert(app.domainKey === "PUBLIC_DOMAIN", "Phosphene domain is not wired");
assert(
  JSON.stringify(app.dependencies) === JSON.stringify(["postgresql", "minio"]),
  "Phosphene service dependencies are incorrect"
);
assert(app.spec.source.image.endsWith(":1.0.0"), "Zeabur must use the pinned Phosphene 1.0.0 image");
assert(app.spec.ports.some((port) => port.id === "web" && port.port === 8080), "Web port 8080 is missing");
assert(app.spec.env.DATABASE_URL.default === "${DATABASE_URL}", "PostgreSQL URL is not wired");
assert(app.spec.env.S3_ENDPOINT.default === "${MINIO_ENDPOINT}", "MinIO endpoint is not wired");
assert(
  minio.spec.source.image.endsWith("phosphene-minio:RELEASE.2025-10-15T17-29-55Z"),
  "Zeabur must use the security-fixed Phosphene MinIO image"
);

assert(compose.services?.app, "Compose app service is missing");
assert(compose.services?.postgresql, "Compose PostgreSQL service is missing");
assert(compose.services?.minio, "Compose MinIO service is missing");
assert(
  compose.services.minio.build?.context === "./infra/minio",
  "Compose must build MinIO from the security-fixed official source"
);
assert(compose.services.app.depends_on.postgresql.condition === "service_healthy", "Compose must wait for PostgreSQL");
assert(compose.services.app.depends_on.minio.condition === "service_healthy", "Compose must wait for MinIO");
for (const secret of ["PHOSPHENE_SETUP_TOKEN", "SESSION_SECRET"]) {
  assert(
    compose.services.app.environment[secret].includes(":?"),
    `Compose must require ${secret} instead of supplying an insecure production default`
  );
}
assert(
  minioDockerfile.includes("github.com/minio/minio@${MINIO_RELEASE}") &&
    minioDockerfile.includes("USER minio") &&
    minioDockerfile.includes("/usr/share/licenses/minio/LICENSE"),
  "MinIO image must build the pinned official source as non-root and include its license"
);

console.log("Single-service image and optional distributed deployment manifests are valid.");
