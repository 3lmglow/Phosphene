import {
  and,
  asc,
  desc,
  eq,
  lte,
  or,
  sql
} from "drizzle-orm";
import type { DomainEventType } from "../db/schema";
import {
  auditLogs,
  domainEvents,
  webhookConfig,
  webhookDeliveries
} from "../db/schema";
import { getDb, runTransaction } from "../db/client";
import { AppError, assertFound, assertState } from "../errors";
import { createId, createSecret } from "../lib/ids";
import type { WebhookSettingsInput } from "../../shared/schemas";

type Db = any;
type Actor = "AI" | "user" | "system";

export const WEBHOOK_MAX_ATTEMPTS = 12;
export const WEBHOOK_LEASE_MS = 30_000;
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;

const RETRY_DELAYS_MS = [
  5_000,
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000
] as const;

async function insertAudit(
  tx: Db,
  action: string,
  entityType: string,
  entityId: string | null,
  summary: string,
  metadata: Record<string, unknown> = {}
) {
  await tx.insert(auditLogs).values({
    id: createId("audit"),
    actor: "user",
    action,
    entityType,
    entityId,
    summary,
    metadata
  });
}

async function getConfig(tx: Db) {
  return assertFound(
    await tx.query.webhookConfig.findFirst({ where: eq(webhookConfig.id, 1) }),
    "Webhook configuration is missing"
  );
}

export async function emitDomainEvent(
  tx: Db,
  input: {
    type: DomainEventType;
    aggregateType: string;
    aggregateId: string;
    actor: Actor;
    dedupeKey: string;
    payload: Record<string, unknown>;
    forceDelivery?: boolean;
  }
) {
  const eventId = createId("event");
  const [created] = await tx
    .insert(domainEvents)
    .values({
      id: eventId,
      type: input.type,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      actor: input.actor,
      dedupeKey: input.dedupeKey,
      payload: input.payload
    })
    .onConflictDoNothing({ target: domainEvents.dedupeKey })
    .returning();
  const event =
    created ??
    assertFound(
      await tx.query.domainEvents.findFirst({
        where: eq(domainEvents.dedupeKey, input.dedupeKey)
      }),
      "Domain event could not be created"
    );
  if (!created) return event;

  const config = await getConfig(tx);
  const subscribed =
    Array.isArray(config.eventTypes) && config.eventTypes.includes(input.type);
  if ((input.forceDelivery || config.enabled) && config.url && (input.forceDelivery || subscribed)) {
    await tx
      .insert(webhookDeliveries)
      .values({
        id: createId("delivery"),
        eventId: event.id
      })
      .onConflictDoNothing({ target: webhookDeliveries.eventId });
  }
  return event;
}

export async function getWebhookSettings() {
  const db = getDb();
  const config = await getConfig(db);
  const counts = await db
    .select({ status: webhookDeliveries.status, count: sql<number>`count(*)` })
    .from(webhookDeliveries)
    .groupBy(webhookDeliveries.status);
  return {
    enabled: config.enabled,
    url: config.url,
    event_types: config.eventTypes,
    has_signing_secret: Boolean(config.signingSecret),
    updated_at: config.updatedAt,
    deliveries: Object.fromEntries(
      counts.map((row: any) => [row.status, Number(row.count)])
    )
  };
}

export async function updateWebhookSettings(input: WebhookSettingsInput) {
  return runTransaction(async (tx: Db) => {
    const current = await getConfig(tx);
    await tx
      .update(webhookConfig)
      .set({
        enabled: input.enabled,
        url: input.url,
        eventTypes: input.event_types,
        updatedAt: new Date()
      })
      .where(eq(webhookConfig.id, 1));
    const hostname = input.url ? new URL(input.url).hostname : "";
    await insertAudit(
      tx,
      "webhook.updated",
      "webhook_config",
      "1",
      "Webhook notification settings updated",
      {
        enabled: input.enabled,
        hostname,
        eventTypes: input.event_types,
        destinationChanged: current.url !== input.url
      }
    );
    return getWebhookSettingsFromTransaction(tx);
  });
}

async function getWebhookSettingsFromTransaction(tx: Db) {
  const config = await getConfig(tx);
  return {
    enabled: config.enabled,
    url: config.url,
    event_types: config.eventTypes,
    has_signing_secret: Boolean(config.signingSecret),
    updated_at: config.updatedAt
  };
}

export async function rotateWebhookSecret() {
  return runTransaction(async (tx: Db) => {
    const secret = `phosphene_webhook_${createSecret(32)}`;
    await tx
      .update(webhookConfig)
      .set({ signingSecret: secret, updatedAt: new Date() })
      .where(eq(webhookConfig.id, 1));
    await insertAudit(
      tx,
      "webhook.secret_rotated",
      "webhook_config",
      "1",
      "Webhook signing secret rotated"
    );
    return {
      signing_secret: secret,
      warning: "This signing secret is shown once. Store it in the receiving service."
    };
  });
}

export async function createWebhookTestEvent() {
  return runTransaction(async (tx: Db) => {
    const config = await getConfig(tx);
    assertState(config.enabled, "webhook_disabled", "Enable the Webhook before sending a test");
    assertState(Boolean(config.url), "webhook_url_required", "Configure a Webhook URL before sending a test");
    const testId = createId("webhook_test");
    const event = await emitDomainEvent(tx, {
      type: "notification.test",
      aggregateType: "webhook_config",
      aggregateId: "1",
      actor: "user",
      dedupeKey: `notification.test:${testId}`,
      payload: { test_id: testId, message: "Phosphene Webhook delivery test" },
      forceDelivery: true
    });
    await insertAudit(
      tx,
      "webhook.test_enqueued",
      "domain_event",
      event.id,
      "Webhook test event queued"
    );
    return { event_id: event.id, queued: true };
  });
}

export async function listWebhookDeliveries(limit = 20) {
  return getDb().query.webhookDeliveries.findMany({
    orderBy: [desc(webhookDeliveries.createdAt)],
    limit: Math.min(Math.max(limit, 1), 100),
    with: { event: true }
  });
}

export async function retryWebhookDelivery(deliveryId: string) {
  return runTransaction(async (tx: Db) => {
    const delivery = assertFound(
      await tx.query.webhookDeliveries.findFirst({
        where: eq(webhookDeliveries.id, deliveryId)
      }),
      "Webhook delivery not found"
    );
    assertState(
      delivery.status !== "delivered",
      "delivery_already_succeeded",
      "A delivered Webhook cannot be retried"
    );
    await tx
      .update(webhookDeliveries)
      .set({
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: null,
        lastStatusCode: null,
        updatedAt: new Date()
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    await insertAudit(
      tx,
      "webhook.delivery_retried",
      "webhook_delivery",
      delivery.id,
      "Webhook delivery queued for manual retry"
    );
    return { delivery_id: delivery.id, status: "pending" };
  });
}

export type ClaimedWebhookDelivery = {
  deliveryId: string;
  leaseToken: string;
  attempt: number;
  url: string;
  signingSecret: string;
  event: {
    id: string;
    sequence: number;
    type: DomainEventType;
    actor: Actor;
    aggregateType: string;
    aggregateId: string;
    version: number;
    payload: Record<string, unknown>;
    createdAt: Date;
  };
};

async function findClaimableDelivery(db: Db, now: Date) {
  const config = await getConfig(db);
  if (!config.enabled || !config.url) return null;
  const candidate = await db.query.webhookDeliveries.findFirst({
    where: or(
      and(
        eq(webhookDeliveries.status, "pending"),
        lte(webhookDeliveries.nextAttemptAt, now)
      ),
      and(
        eq(webhookDeliveries.status, "processing"),
        lte(webhookDeliveries.leaseExpiresAt, now)
      )
    ),
    orderBy: [asc(webhookDeliveries.createdAt)]
  });
  return candidate ? { config, candidate } : null;
}

export async function claimWebhookDelivery(
  now = new Date()
): Promise<ClaimedWebhookDelivery | null> {
  if (!(await findClaimableDelivery(getDb(), now))) return null;
  return runTransaction(async (tx: Db) => {
    const claimable = await findClaimableDelivery(tx, now);
    if (!claimable) return null;
    const { config, candidate } = claimable;
    const event = assertFound(
      await tx.query.domainEvents.findFirst({
        where: eq(domainEvents.id, candidate.eventId)
      }),
      "Webhook event not found"
    );
    const leaseToken = createSecret(24);
    const attempt = candidate.attemptCount + 1;
    await tx
      .update(webhookDeliveries)
      .set({
        status: "processing",
        attemptCount: attempt,
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + WEBHOOK_LEASE_MS),
        lastAttemptAt: now,
        updatedAt: now
      })
      .where(eq(webhookDeliveries.id, candidate.id));
    return {
      deliveryId: candidate.id,
      leaseToken,
      attempt,
      url: config.url,
      signingSecret: config.signingSecret,
      event: {
        id: event.id,
        sequence: event.sequence,
        type: event.type,
        actor: event.actor,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        version: event.version,
        payload: event.payload,
        createdAt: event.createdAt
      }
    };
  });
}

export async function markWebhookDelivered(
  deliveryId: string,
  leaseToken: string,
  statusCode: number,
  now = new Date()
) {
  await runTransaction((tx: Db) =>
    tx
      .update(webhookDeliveries)
      .set({
        status: "delivered",
        deliveredAt: now,
        lastStatusCode: statusCode,
        lastError: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now
      })
      .where(
        and(
          eq(webhookDeliveries.id, deliveryId),
          eq(webhookDeliveries.status, "processing"),
          eq(webhookDeliveries.leaseToken, leaseToken)
        )
      )
  );
}

export function retryDelayForAttempt(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1)];
}

export async function markWebhookFailed(
  deliveryId: string,
  leaseToken: string,
  error: string,
  statusCode: number | null,
  retryAfterMs?: number,
  now = new Date()
) {
  return runTransaction(async (tx: Db) => {
    const delivery = await tx.query.webhookDeliveries.findFirst({
      where: and(
        eq(webhookDeliveries.id, deliveryId),
        eq(webhookDeliveries.status, "processing"),
        eq(webhookDeliveries.leaseToken, leaseToken)
      )
    });
    if (!delivery) return { stale: true, status: null };
    const dead = delivery.attemptCount >= WEBHOOK_MAX_ATTEMPTS;
    const delay = Math.min(
      Math.max(retryAfterMs ?? retryDelayForAttempt(delivery.attemptCount), 1_000),
      60 * 60_000
    );
    const status = dead ? "dead_letter" : "pending";
    await tx
      .update(webhookDeliveries)
      .set({
        status,
        nextAttemptAt: new Date(now.getTime() + delay),
        leaseToken: null,
        leaseExpiresAt: null,
        lastStatusCode: statusCode,
        lastError: error.slice(0, 1000),
        updatedAt: now
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    return { stale: false, status };
  });
}

export function parseRetryAfter(value: string | null, now = new Date()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = new Date(value);
  if (!Number.isNaN(date.valueOf())) return Math.max(0, date.valueOf() - now.valueOf());
  return undefined;
}

export function validateWebhookDestination(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(409, "invalid_webhook_url", "Webhook URL is invalid");
  }
  assertState(
    ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash,
    "invalid_webhook_url",
    "Webhook URL must use HTTP or HTTPS without embedded credentials or a fragment"
  );
  return url;
}
