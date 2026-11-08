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
    forget(intent: string) {
      keys.delete(intent);
    }
  };
}

// A 4xx carrying the server's own error code means it read the request and turned it down, so nothing happened.
// No connection, a 5xx or a reply that could not be read ("request_failed" in api.ts) leave the outcome unknown.
export function isDefinitiveRejection(reason: unknown) {
  return reason instanceof ApiError && reason.status >= 400 && reason.status < 500 && reason.code !== "request_failed";
}
