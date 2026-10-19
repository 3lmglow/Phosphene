import { createHash } from "node:crypto";
import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, runTransaction } from "../db/client";
import { auditLogs, oauthAuthorizationCodes, oauthClients, oauthGrants } from "../db/schema";
import { AppError } from "../errors";
import { createId, createSecret, tokenHash } from "../lib/ids";

export const OAUTH_SCOPE = "phosphene";
export const OAUTH_ACCESS_TOKEN_PREFIX = "phosphene_oauth_at_";
const REFRESH_TOKEN_PREFIX = "phosphene_oauth_rt_";
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_REQUESTS = 100;
const MAX_METADATA_DOCUMENT_BYTES = 8 * 1024;
const LAST_USED_RESOLUTION_MS = 60 * 1000;

export class OAuthError extends Error {
  constructor(
    public error: string,
    public description: string,
    public status = 400
  ) {
    super(description);
  }
}

type OAuthClient = { clientId: string; clientName: string; redirectUris: string[] };

type PendingRequest = OAuthClient & {
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  resource?: string;
  expiresAt: number;
};

const pendingRequests = new Map<string, PendingRequest>();

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true
  };
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Phosphene"
  };
}

export function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function isClientMetadataDocumentUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.pathname.length > 1 &&
    !url.hash &&
    !url.username &&
    !url.password &&
    url.hostname.includes(".") &&
    !/^[\d.]+$/.test(url.hostname) &&
    !url.hostname.startsWith("[") &&
    url.hostname !== "localhost"
  );
}

const metadataDocumentSchema = z.object({
  client_id: z.string(),
  client_name: z.string().trim().max(100).optional(),
  redirect_uris: z.array(z.string()).min(1).max(10)
});

async function fetchClientMetadataDocument(clientId: string): Promise<OAuthClient> {
  const response = await fetch(clientId, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Client metadata returned HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_METADATA_DOCUMENT_BYTES) throw new Error("Client metadata is too large");
  const document = metadataDocumentSchema.parse(JSON.parse(text));
  if (document.client_id !== clientId) throw new Error("Client metadata does not describe this client_id");
  if (!document.redirect_uris.every(isAllowedRedirectUri)) throw new Error("Client metadata has an unsafe redirect URI");
  return {
    clientId,
    clientName: document.client_name || new URL(clientId).hostname,
    redirectUris: document.redirect_uris
  };
}

async function resolveClient(clientId: string): Promise<OAuthClient | null> {
  if (isClientMetadataDocumentUrl(clientId)) {
    return fetchClientMetadataDocument(clientId).catch(() => null);
  }
  const row = await getDb().query.oauthClients.findFirst({ where: eq(oauthClients.clientId, clientId) });
  return row ? { clientId: row.clientId, clientName: row.clientName, redirectUris: row.redirectUris } : null;
}

const registrationSchema = z
  .object({
    redirect_uris: z.array(z.string()).min(1).max(10),
    client_name: z.string().trim().max(100).optional()
  })
  .passthrough();

export async function registerClient(body: unknown) {
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) throw new OAuthError("invalid_client_metadata", "redirect_uris is required");
  const { redirect_uris: redirectUris, client_name: clientName } = parsed.data;
  if (!redirectUris.every(isAllowedRedirectUri)) {
    throw new OAuthError("invalid_redirect_uri", "Redirect URIs must use HTTPS or a loopback address");
  }
  const clientId = createId("client");
  const name = clientName || new URL(redirectUris[0]).hostname;
  await runTransaction((tx) =>
    tx.insert(oauthClients).values({ clientId, clientName: name, redirectUris })
  );
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  };
}

function acceptedResource(origin: string, resource?: string) {
  if (!resource) return undefined;
  if (resource === origin || resource === `${origin}/mcp` || resource === `${origin}/`) return resource;
  throw new OAuthError("invalid_target", "This server only protects its own MCP endpoint");
}

export function authorizationRedirect(redirectUri: string, params: Record<string, string | undefined>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

type AuthorizationQuery = Partial<Record<
  "response_type" | "client_id" | "redirect_uri" | "code_challenge" | "code_challenge_method" | "state" | "resource",
  string
>>;

export type AuthorizationStart =
  | { kind: "consent"; requestId: string }
  | { kind: "redirect"; location: string }
  | { kind: "invalid"; error: string };

export async function startAuthorization(query: AuthorizationQuery, origin: string): Promise<AuthorizationStart> {
  const client = query.client_id ? await resolveClient(query.client_id) : null;
  if (!client) return { kind: "invalid", error: "invalid_client" };
  const redirectUri = query.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) return { kind: "invalid", error: "invalid_redirect_uri" };

  const fail = (error: string, description: string): AuthorizationStart => ({
    kind: "redirect",
    location: authorizationRedirect(redirectUri, { error, error_description: description, state: query.state, iss: origin })
  });
  if (query.response_type !== "code") return fail("unsupported_response_type", "Only the authorization code flow is supported");
  if (!query.code_challenge || query.code_challenge_method !== "S256") {
    return fail("invalid_request", "PKCE with S256 is required");
  }
  let resource: string | undefined;
  try {
    resource = acceptedResource(origin, query.resource);
  } catch (error) {
    return fail("invalid_target", (error as Error).message);
  }

  const now = Date.now();
  for (const [id, pending] of pendingRequests) {
    if (pending.expiresAt <= now) pendingRequests.delete(id);
  }
  while (pendingRequests.size >= MAX_PENDING_REQUESTS) {
    pendingRequests.delete(pendingRequests.keys().next().value!);
  }
  const requestId = createSecret(18);
  pendingRequests.set(requestId, {
    ...client,
    redirectUri,
    state: query.state,
    codeChallenge: query.code_challenge,
    resource,
    expiresAt: now + REQUEST_TTL_MS
  });
  return { kind: "consent", requestId };
}

function pendingRequest(requestId: string): PendingRequest {
  const pending = pendingRequests.get(requestId);
  if (!pending || pending.expiresAt <= Date.now()) {
    pendingRequests.delete(requestId);
    throw new AppError(404, "oauth_request_expired", "这次连接请求已经过期，请回到 AI 应用重新连接。");
  }
  return pending;
}

export function describeAuthorizationRequest(requestId: string) {
  const pending = pendingRequest(requestId);
  return {
    client_name: pending.clientName,
    redirect_host: new URL(pending.redirectUri).host
  };
}

export async function approveAuthorizationRequest(requestId: string, origin: string) {
  const pending = pendingRequest(requestId);
  pendingRequests.delete(requestId);
  const code = createSecret(32);
  await runTransaction(async (tx) => {
    await tx.delete(oauthAuthorizationCodes).where(lte(oauthAuthorizationCodes.expiresAt, new Date()));
    await tx.insert(oauthAuthorizationCodes).values({
      codeHash: tokenHash(code),
      clientId: pending.clientId,
      clientName: pending.clientName,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      resource: pending.resource,
      expiresAt: new Date(Date.now() + CODE_TTL_MS)
    });
  });
  return { redirect_to: authorizationRedirect(pending.redirectUri, { code, state: pending.state, iss: origin }) };
}

export function denyAuthorizationRequest(requestId: string, origin: string) {
  const pending = pendingRequest(requestId);
  pendingRequests.delete(requestId);
  return {
    redirect_to: authorizationRedirect(pending.redirectUri, {
      error: "access_denied",
      error_description: "The user declined the connection",
      state: pending.state,
      iss: origin
    })
  };
}

function issueTokens() {
  const accessToken = `${OAUTH_ACCESS_TOKEN_PREFIX}${createSecret(32)}`;
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${createSecret(32)}`;
  const now = Date.now();
  return {
    accessToken,
    refreshToken,
    columns: {
      accessTokenHash: tokenHash(accessToken),
      accessExpiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
      refreshTokenHash: tokenHash(refreshToken),
      refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS)
    }
  };
}

function tokenResponse(tokens: { accessToken: string; refreshToken: string }) {
  return {
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    refresh_token: tokens.refreshToken,
    scope: OAUTH_SCOPE
  };
}

function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

const field = (body: Record<string, unknown>, name: string) =>
  typeof body[name] === "string" && body[name] ? (body[name] as string) : undefined;

export async function exchangeToken(body: Record<string, unknown>, origin: string) {
  const grantType = field(body, "grant_type");
  if (grantType === "authorization_code") return exchangeAuthorizationCode(body, origin);
  if (grantType === "refresh_token") return refreshGrant(body);
  throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

async function exchangeAuthorizationCode(body: Record<string, unknown>, origin: string) {
  const code = field(body, "code");
  const verifier = field(body, "code_verifier");
  if (!code || !verifier) throw new OAuthError("invalid_request", "code and code_verifier are required");
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError("invalid_grant", "Invalid code_verifier");
  const resource = acceptedResource(origin, field(body, "resource"));
  return runTransaction(async (tx) => {
    const [row] = await tx
      .delete(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.codeHash, tokenHash(code)))
      .returning();
    const clientId = field(body, "client_id");
    const redirectUri = field(body, "redirect_uri");
    if (
      !row ||
      row.expiresAt.getTime() <= Date.now() ||
      (clientId && clientId !== row.clientId) ||
      (redirectUri && redirectUri !== row.redirectUri) ||
      pkceChallenge(verifier) !== row.codeChallenge
    ) {
      throw new OAuthError("invalid_grant", "The authorization code is invalid, expired or already used");
    }
    const tokens = issueTokens();
    const grantId = createId("grant");
    await tx.insert(oauthGrants).values({
      id: grantId,
      clientId: row.clientId,
      clientName: row.clientName,
      redirectUri: row.redirectUri,
      resource: resource ?? row.resource,
      ...tokens.columns
    });
    await tx.insert(auditLogs).values({
      id: createId("audit"),
      actor: "user",
      action: "oauth.authorized",
      entityType: "oauth_grant",
      entityId: grantId,
      summary: `Authorized ${row.clientName} to connect over MCP`
    });
    return tokenResponse(tokens);
  });
}

async function refreshGrant(body: Record<string, unknown>) {
  const refreshToken = field(body, "refresh_token");
  if (!refreshToken) throw new OAuthError("invalid_request", "refresh_token is required");
  return runTransaction(async (tx) => {
    const grant = await tx.query.oauthGrants.findFirst({
      where: eq(oauthGrants.refreshTokenHash, tokenHash(refreshToken))
    });
    const clientId = field(body, "client_id");
    if (
      !grant ||
      grant.revokedAt ||
      grant.refreshExpiresAt.getTime() <= Date.now() ||
      (clientId && clientId !== grant.clientId)
    ) {
      throw new OAuthError("invalid_grant", "The refresh token is invalid, expired or revoked");
    }
    const tokens = issueTokens();
    await tx.update(oauthGrants).set(tokens.columns).where(eq(oauthGrants.id, grant.id));
    return tokenResponse(tokens);
  });
}

export async function revokeToken(body: Record<string, unknown>) {
  const token = field(body, "token");
  if (!token) return;
  const hash = tokenHash(token);
  await runTransaction((tx) =>
    tx
      .update(oauthGrants)
      .set({ revokedAt: new Date() })
      .where(
        and(
          isNull(oauthGrants.revokedAt),
          or(eq(oauthGrants.accessTokenHash, hash), eq(oauthGrants.refreshTokenHash, hash))
        )
      )
  );
}

export async function verifyAccessToken(token: string): Promise<boolean> {
  const grant = await getDb().query.oauthGrants.findFirst({
    where: eq(oauthGrants.accessTokenHash, tokenHash(token))
  });
  const now = Date.now();
  if (!grant || grant.revokedAt || grant.accessExpiresAt.getTime() <= now) return false;
  if (!grant.lastUsedAt || now - grant.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await runTransaction((tx) =>
      tx.update(oauthGrants).set({ lastUsedAt: new Date(now) }).where(eq(oauthGrants.id, grant.id))
    );
  }
  return true;
}

export async function listGrants() {
  const rows = await getDb().query.oauthGrants.findMany({
    where: and(isNull(oauthGrants.revokedAt), gt(oauthGrants.refreshExpiresAt, new Date())),
    orderBy: (grants, { desc }) => [desc(grants.createdAt)]
  });
  return rows.map((row) => ({
    id: row.id,
    client_name: row.clientName,
    redirect_host: new URL(row.redirectUri).host,
    created_at: row.createdAt,
    last_used_at: row.lastUsedAt
  }));
}

export async function revokeGrant(grantId: string) {
  return runTransaction(async (tx) => {
    const [grant] = await tx
      .update(oauthGrants)
      .set({ revokedAt: new Date() })
      .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)))
      .returning();
    if (!grant) throw new AppError(404, "oauth_grant_not_found", "这个授权不存在或已经撤销。");
    await tx.insert(auditLogs).values({
      id: createId("audit"),
      actor: "user",
      action: "oauth.revoked",
      entityType: "oauth_grant",
      entityId: grant.id,
      summary: `Revoked MCP access for ${grant.clientName}`
    });
    return { revoked: true };
  });
}
