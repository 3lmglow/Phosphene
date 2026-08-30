import { createHmac } from "node:crypto";
import type { Logger } from "pino";
import { AppError } from "../errors";
import { beginApplicationRequest } from "./backup";
import {
  claimWebhookDelivery,
  markWebhookDelivered,
  markWebhookFailed,
  parseRetryAfter,
  validateWebhookDestination,
  WEBHOOK_REQUEST_TIMEOUT_MS,
  type ClaimedWebhookDelivery
} from "./events";

const IDLE_POLL_MS = 2_000;

let workerStarted = false;
let workerStopping = false;
let timer: NodeJS.Timeout | null = null;
let activeTick: Promise<void> | null = null;
let workerLogger: Logger | null = null;

function schedule(delay: number) {
  if (!workerStarted || workerStopping) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    activeTick = runTick().finally(() => {
      activeTick = null;
    });
  }, delay);
  timer.unref?.();
}

function eventEnvelope(claim: ClaimedWebhookDelivery) {
  return {
    id: claim.event.id,
    sequence: claim.event.sequence,
    type: claim.event.type,
    version: claim.event.version,
    created_at: claim.event.createdAt.toISOString(),
    actor: claim.event.actor,
    aggregate: {
      type: claim.event.aggregateType,
      id: claim.event.aggregateId
    },
    data: claim.event.payload
  };
}

export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

export async function deliverWebhookClaim(
  claim: ClaimedWebhookDelivery,
  requestTimeoutMs = WEBHOOK_REQUEST_TIMEOUT_MS
) {
  const destination = validateWebhookDestination(claim.url);
  const body = JSON.stringify(eventEnvelope(claim));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signWebhookBody(claim.signingSecret, timestamp, body);
  try {
    const response = await fetch(destination, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Phosphene-Webhook/1.0",
        "X-Phosphene-Event-Id": claim.event.id,
        "X-Phosphene-Event-Type": claim.event.type,
        "X-Phosphene-Delivery-Id": claim.deliveryId,
        "X-Phosphene-Timestamp": timestamp,
        "X-Phosphene-Signature": `v1=${signature}`,
        "Idempotency-Key": claim.event.id
      },
      body
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) {
      await markWebhookDelivered(
        claim.deliveryId,
        claim.leaseToken,
        response.status
      );
      return;
    }
    const result = await markWebhookFailed(
      claim.deliveryId,
      claim.leaseToken,
      `Webhook returned HTTP ${response.status}`,
      response.status,
      parseRetryAfter(response.headers.get("retry-after"))
    );
    workerLogger?.warn(
      {
        deliveryId: claim.deliveryId,
        eventId: claim.event.id,
        statusCode: response.status,
        deliveryStatus: result.status
      },
      "Webhook delivery failed"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook request failed";
    const result = await markWebhookFailed(
      claim.deliveryId,
      claim.leaseToken,
      message,
      null
    );
    workerLogger?.warn(
      {
        deliveryId: claim.deliveryId,
        eventId: claim.event.id,
        error: message,
        deliveryStatus: result.status
      },
      "Webhook delivery failed"
    );
  }
}

async function runTick() {
  let release: (() => void) | undefined;
  let claimed = false;
  try {
    release = beginApplicationRequest();
    const delivery = await claimWebhookDelivery();
    if (delivery) {
      claimed = true;
      await deliverWebhookClaim(delivery);
    }
  } catch (error) {
    if (!(error instanceof AppError && error.code === "backup_maintenance")) {
      workerLogger?.error({ err: error }, "Webhook worker tick failed");
    }
  } finally {
    release?.();
    schedule(claimed ? 0 : IDLE_POLL_MS);
  }
}

export function startWebhookWorker(logger: Logger) {
  if (workerStarted) return;
  workerStarted = true;
  workerStopping = false;
  workerLogger = logger;
  logger.info("Webhook delivery worker started");
  schedule(0);
}

export async function stopWebhookWorker() {
  if (!workerStarted) return;
  workerStopping = true;
  workerStarted = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await activeTick;
  workerLogger?.info("Webhook delivery worker stopped");
  workerLogger = null;
  workerStopping = false;
}
