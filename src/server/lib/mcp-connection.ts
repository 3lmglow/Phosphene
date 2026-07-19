export const MCP_AUTH_MODES = ["token", "none"] as const;
export type McpAuthMode = (typeof MCP_AUTH_MODES)[number];

export function readMcpToken(
  authorization?: string,
  phospheneHeader?: string
): { token?: string; conflicting: boolean } {
  const bearerMatch = authorization?.match(/^Bearer[ \t]+(.+)$/i);
  const bearerToken = bearerMatch?.[1]?.trim() || undefined;
  const directToken = phospheneHeader?.trim() || undefined;
  return {
    token: bearerToken ?? directToken,
    conflicting: Boolean(
      bearerToken && directToken && bearerToken !== directToken
    )
  };
}

export function authorizationHeaderForToken(token?: string): string | undefined {
  const normalized = token?.trim();
  if (!normalized) return undefined;
  return /^Bearer[ \t]+/i.test(normalized)
    ? normalized
    : `Bearer ${normalized}`;
}

export function normalizeMcpEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (!["http:", "https:"].includes(endpoint.protocol)) {
    throw new Error("PHOSPHENE_MCP_URL must use http:// or https://.");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("Do not place MCP credentials in PHOSPHENE_MCP_URL.");
  }
  if (endpoint.search || endpoint.hash) {
    throw new Error(
      "PHOSPHENE_MCP_URL must not contain query parameters or a fragment."
    );
  }
  if (endpoint.pathname === "/" || endpoint.pathname === "") {
    endpoint.pathname = "/mcp";
  } else if (endpoint.pathname === "/mcp/") {
    endpoint.pathname = "/mcp";
  }
  return endpoint;
}
