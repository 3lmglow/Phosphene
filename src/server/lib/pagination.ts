export type DecodedPageCursor = {
  at: Date;
  key: string | null;
};

export function encodePageCursor(at: Date, key: string): string {
  return `pc_${Buffer.from(
    JSON.stringify({ at: at.toISOString(), key }),
    "utf8"
  ).toString("base64url")}`;
}

export function decodePageCursor(value: string): DecodedPageCursor | null {
  if (!value.startsWith("pc_")) {
    const at = new Date(value);
    return Number.isNaN(at.valueOf()) ? null : { at, key: null };
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value.slice(3), "base64url").toString("utf8")
    ) as { at?: unknown; key?: unknown };
    if (typeof parsed.at !== "string" || typeof parsed.key !== "string" || !parsed.key) {
      return null;
    }
    const at = new Date(parsed.at);
    return Number.isNaN(at.valueOf()) ? null : { at, key: parsed.key };
  } catch {
    return null;
  }
}
