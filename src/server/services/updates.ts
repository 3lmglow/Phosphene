import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod";
import { version as currentVersion } from "../../../package.json";
import { getDb, runTransaction } from "../db/client";
import { appSettings, auditLogs } from "../db/schema";
import { createId } from "../lib/ids";

const UPDATE_REPOSITORY = "3lmglow/Phosphene";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const RELEASE_PAGE_PREFIX = `https://github.com/${UPDATE_REPOSITORY}/releases/`;
const FIRST_CHECK_DELAY_MS = 30 * 1000;
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 60 * 1000;
// Unauthenticated GitHub API calls are limited per IP, which instances on one host may share.
const MIN_CHECK_SPACING_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const TOGGLE_CHECK_WAIT_MS = 4_000;

type LatestRelease = { version: string; name: string; url: string; published_at: string | null };

let latest: LatestRelease | null = null;
let checkedAt: Date | null = null;
let failedAt: Date | null = null;
let lastAttemptAt = 0;
let activeCheck: Promise<void> | null = null;
let checkerStarted = false;
let timer: NodeJS.Timeout | null = null;
let checkerLogger: Logger | null = null;

export function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (!next || !now) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== now[index]) return next[index] > now[index];
  }
  return false;
}

const releaseSchema = z.object({
  tag_name: z.string(),
  name: z.string().nullish(),
  html_url: z.string(),
  published_at: z.string().nullish(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional()
});

async function readLimitedText(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    throw new Error("GitHub release response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("GitHub release response is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<LatestRelease> {
  const response = await fetchImpl(LATEST_RELEASE_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `Phosphene/${currentVersion}`,
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const release = releaseSchema.parse(JSON.parse(await readLimitedText(response)));
  const parsed = parseVersion(release.tag_name);
  if (!parsed || release.draft || release.prerelease) throw new Error("The latest release has no usable version");
  // The page is linked from the website, so only a release page of the upstream repository is accepted.
  if (!release.html_url.startsWith(RELEASE_PAGE_PREFIX)) throw new Error("The latest release has an unexpected address");
  return {
    version: parsed.join("."),
    name: (release.name?.trim() || `Phosphene ${release.tag_name}`).slice(0, 120),
    url: release.html_url,
    published_at: release.published_at ?? null
  };
}

export function checkForUpdates(fetchImpl?: typeof fetch): Promise<void> {
  if (activeCheck) return activeCheck;
  if (Date.now() - lastAttemptAt < MIN_CHECK_SPACING_MS) return Promise.resolve();
  lastAttemptAt = Date.now();
  activeCheck = fetchLatestRelease(fetchImpl)
    .then((release) => {
      latest = release;
      checkedAt = new Date();
      failedAt = null;
    })
    .catch((error) => {
      failedAt = new Date();
      checkerLogger?.warn({ error: error instanceof Error ? error.message : String(error) }, "Update check failed");
    })
    .finally(() => {
      activeCheck = null;
    });
  return activeCheck;
}

async function isUpdateCheckEnabled(): Promise<boolean> {
  const [row] = await getDb()
    .select({ enabled: appSettings.updateCheckEnabled })
    .from(appSettings)
    .where(eq(appSettings.id, 1));
  return row?.enabled ?? true;
}

export async function getUpdateStatus() {
  const enabled = await isUpdateCheckEnabled();
  return {
    enabled,
    current_version: currentVersion,
    latest: enabled ? latest : null,
    update_available: enabled && latest !== null && isNewerVersion(latest.version, currentVersion),
    checked_at: enabled ? checkedAt?.toISOString() ?? null : null,
    check_failed: enabled && failedAt !== null
  };
}

export async function setUpdateCheckEnabled(enabled: boolean) {
  await runTransaction(async (tx) => {
    await tx
      .update(appSettings)
      .set({ updateCheckEnabled: enabled, updatedAt: new Date() })
      .where(eq(appSettings.id, 1));
    await tx.insert(auditLogs).values({
      id: createId("audit"),
      actor: "user",
      action: "settings.update_check",
      entityType: "settings",
      entityId: "1",
      summary: enabled ? "Automatic update checks turned on" : "Automatic update checks turned off",
      metadata: { enabled }
    });
  });
  if (enabled) {
    // Give the first check a moment so the switch can show the result, without hanging on a slow network.
    await Promise.race([
      checkForUpdates(),
      new Promise((resolve) => setTimeout(resolve, TOGGLE_CHECK_WAIT_MS).unref?.())
    ]);
  }
  return getUpdateStatus();
}

function schedule(delay: number) {
  if (!checkerStarted) return;
  if (timer) clearTimeout(timer);
  // Spread instances that restart together so they do not all ask GitHub at the same moment.
  timer = setTimeout(() => void runScheduledCheck(), delay + Math.floor(Math.random() * 60_000));
  timer.unref?.();
}

async function runScheduledCheck() {
  timer = null;
  try {
    if (await isUpdateCheckEnabled()) await checkForUpdates();
  } catch (error) {
    checkerLogger?.warn({ err: error }, "Update check could not run");
  } finally {
    schedule(failedAt ? RETRY_INTERVAL_MS : CHECK_INTERVAL_MS);
  }
}

export function startUpdateChecker(logger: Logger) {
  if (checkerStarted) return;
  checkerStarted = true;
  checkerLogger = logger;
  schedule(FIRST_CHECK_DELAY_MS);
}

export function stopUpdateChecker() {
  checkerStarted = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

export function resetUpdateStateForTests() {
  latest = null;
  checkedAt = null;
  failedAt = null;
  lastAttemptAt = 0;
  activeCheck = null;
}
