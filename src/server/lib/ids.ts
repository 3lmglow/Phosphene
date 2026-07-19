import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";

export function createId(prefix: string): string {
  return `${prefix}_${nanoid(16)}`;
}

export function createSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function tokenHash(token: string): string {
  return sha256(token);
}
