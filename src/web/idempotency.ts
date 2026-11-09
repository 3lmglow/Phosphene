import { ApiError, idempotencyKey } from "./api";

// One key per thing the user is trying to do (for example, redeeming one reward), kept until the server has
// clearly answered. A retry after a lost reply sends the same key, so the server returns its first answer
// instead of doing the work a second time.
export function createRetryKeys(prefix: string) {
  const keys = new Map<string, string>();
  return {
    get(intent: string) {
      let key = keys.get(intent);
      if (!key) {
        key = idempotencyKey(prefix);
        keys.set(intent, key);
      }
      return key;
    },
    // Drops the key only if it is still the one that attempt sent: a late reply to an older attempt must not
    // throw away the key of a newer one that is still waiting for its answer.
    forget(intent: string, key: string) {
      if (keys.get(intent) === key) keys.delete(intent);
    }
  };
}

// Refusals the redemption itself gives once the server has looked the key up: the reward is gone or archived,
// there are not enough points, or the key belongs to another request. Only these prove the key never went
// through. Anything turned away before that lookup (signed out, CSRF, rate limits, a body the server would not
// read) or with no readable answer says nothing about an earlier attempt, so the key is kept.
const REDEMPTION_REFUSALS = new Set(["not_found", "insufficient_points", "idempotency_conflict", "idempotency_payload_conflict"]);

export function isRedemptionRefusal(reason: unknown) {
  return reason instanceof ApiError && REDEMPTION_REFUSALS.has(reason.code);
}
