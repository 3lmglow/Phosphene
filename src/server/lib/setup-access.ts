import { timingSafeEqual } from "node:crypto";

export function acceptsSetupToken(configuredToken: string | undefined, presentedToken: string) {
  if (!configuredToken) return true;
  const configured = Buffer.from(configuredToken);
  const presented = Buffer.from(presentedToken);
  return configured.length === presented.length && timingSafeEqual(configured, presented);
}
