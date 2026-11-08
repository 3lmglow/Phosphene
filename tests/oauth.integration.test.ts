import { createHash, randomBytes } from "node:crypto";
import dns from "node:dns";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import cookieParser from "cookie-parser";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/server/config";
import { initializeDatabase, shutdownDatabase } from "../src/server/db/client";
import { seedDatabase } from "../src/server/db/seed";
import { handleMcp } from "../src/server/mcp";
import oauthRouter from "../src/server/oauth";
import router, { apiErrorHandler } from "../src/server/routes";
import { requireAi } from "../src/server/services/auth";
import { isClientMetadataDocumentUrl, isPublicAddress } from "../src/server/services/oauth";

const CALLBACK = "http://127.0.0.1:9/callback";
const realFetch = globalThis.fetch;
let server: ReturnType<typeof express.application.listen>;
let base: string;
const jar = new Map<string, string>();
let metadataServer: http.Server;
let metadataHandler: http.RequestListener = (_request, response) => response.writeHead(404).end();

// Answers the server's HTTPS metadata requests from a local plain-HTTP server instead of the internet.
// It connects by IP, so the public-address check is bypassed here and tested separately below.
function serveMetadata(handler: http.RequestListener) {
  metadataHandler = handler;
  const { port } = metadataServer.address() as AddressInfo;
  vi.spyOn(https, "get").mockImplementation(((url: string, options: https.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    const target = new URL(url);
    const { lookup: _lookup, ...rest } = options;
    return http.get({ ...rest, host: "127.0.0.1", port, path: target.pathname, headers: { ...rest.headers, host: target.host } }, callback);
  }) as unknown as typeof https.get);
}

function metadataDocument(clientId: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    client_id: clientId,
    client_name: "Metadata Client",
    redirect_uris: ["https://client.example.com/callback"],
    ...extra
  });
}

// Resolves when the connection closes; for a body that never ends, only the client hanging up can do that.
function closedByClient(response: http.ServerResponse) {
  return new Promise<void>((resolve) => response.once("close", resolve));
}

async function call(pathname: string, init: RequestInit = {}, withSession = true) {
  const headers = new Headers(init.headers);
  if (withSession) {
    headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
    headers.set("x-csrf-token", jar.get("phosphene_csrf") ?? "");
  }
  const response = await realFetch(`${base}${pathname}`, { ...init, headers, redirect: "manual" });
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const [name, ...value] = pair.split("=");
    jar.set(name, value.join("="));
  }
  return response;
}

async function json(pathname: string, init: RequestInit = {}, withSession = true) {
  const response = await call(pathname, init, withSession);
  return { status: response.status, body: await response.json() };
}

const post = (body: Record<string, unknown>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

const form = (body: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body)
});

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function registerTestClient(redirectUris = [CALLBACK]) {
  const { status, body } = await json("/oauth/register", post({ client_name: "Manual Client", redirect_uris: redirectUris }), false);
  expect(status).toBe(201);
  return body.client_id as string;
}

async function authorize(params: Record<string, string>) {
  const response = await call(`/oauth/authorize?${new URLSearchParams(params)}`, {}, false);
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!, base);
}

async function consentAndApprove(params: Record<string, string>) {
  const consent = await authorize(params);
  expect(consent.pathname).toBe("/connect");
  const approved = await json(`/api/oauth/requests/${consent.searchParams.get("request")}/approve`, { method: "POST" });
  expect(approved.status).toBe(200);
  return new URL(approved.body.data.redirect_to);
}

class TestProvider implements OAuthClientProvider {
  information?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  authorizationUrl?: URL;
  get redirectUrl() {
    return CALLBACK;
  }
  get clientMetadata() {
    return {
      client_name: "SDK Test Client",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    };
  }
  clientInformation() {
    return this.information;
  }
  saveClientInformation(information: OAuthClientInformationMixed) {
    this.information = information;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

beforeAll(async () => {
  const directory = path.resolve(".data/oauth-integration");
  await fs.mkdir(directory, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) await fs.rm(path.join(directory, `test.sqlite${suffix}`), { force: true });
  config.SQLITE_PATH = path.join(directory, "test.sqlite");
  await initializeDatabase();
  await seedDatabase();
  const app = express();
  app.set("trust proxy", 1);
  app.use(cookieParser(), express.json(), express.urlencoded({ extended: false }));
  app.use(oauthRouter);
  app.use("/api", router);
  app.all("/mcp", requireAi, (request, response, next) => {
    handleMcp(request, response).catch(next);
  });
  app.use(apiErrorHandler);
  metadataServer = http.createServer((request, response) => metadataHandler(request, response));
  await new Promise<void>((resolve) => metadataServer.listen(0, "127.0.0.1", resolve));
  server = app.listen(0, "127.0.0.1");
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const setup = await json("/api/setup", post({
    setup_token: "",
    password: "oauth-test-password",
    timezone: "Asia/Shanghai",
    user_label: "你",
    ai_label: "AI"
  }));
  expect(setup.status).toBe(201);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  server.closeAllConnections();
  await closed;
  metadataServer.closeAllConnections();
  await new Promise<void>((resolve) => metadataServer.close(() => resolve()));
  await shutdownDatabase();
});

describe.sequential("OAuth for remote MCP connectors", () => {
  it("publishes discovery metadata that MCP clients can follow from a 401", async () => {
    const unauthenticated = await call("/mcp", post({ jsonrpc: "2.0", id: 1, method: "ping" }), false);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="phosphene"`
    );
    const resource = await json("/.well-known/oauth-protected-resource/mcp", {}, false);
    expect(resource.body).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const metadata = await json("/.well-known/oauth-authorization-server", {}, false);
    expect(metadata.body).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true
    });
    expect((await call("/.well-known/openid-configuration", {}, false)).status).toBe(404);
  });

  it("lets the official SDK client register, get consent, exchange the code and call tools", async () => {
    const provider = new TestProvider();
    expect(await auth(provider, { serverUrl: `${base}/mcp` })).toBe("REDIRECT");
    const authorizationUrl = provider.authorizationUrl!;
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(`${base}/oauth/authorize`);

    const consent = await authorize(Object.fromEntries(authorizationUrl.searchParams));
    const requestId = consent.searchParams.get("request")!;
    const details = await json(`/api/oauth/requests/${requestId}`, {}, false);
    expect(details.body.data).toEqual({ client_name: "SDK Test Client", redirect_host: "127.0.0.1:9" });

    const approved = await json(`/api/oauth/requests/${requestId}/approve`, { method: "POST" });
    const callback = new URL(approved.body.data.redirect_to);
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK);
    expect(callback.searchParams.get("iss")).toBe(base);
    expect(callback.searchParams.get("state")).toBe(authorizationUrl.searchParams.get("state"));

    expect(await auth(provider, { serverUrl: `${base}/mcp`, authorizationCode: callback.searchParams.get("code")! })).toBe("AUTHORIZED");
    const client = new Client({ name: "oauth-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
    const overview = await client.callTool({ name: "get_overview", arguments: {} });
    expect(overview.isError).toBeFalsy();
    await client.close();

    const grants = await json("/api/oauth/grants");
    expect(grants.body.data).toEqual([
      expect.objectContaining({ client_name: "SDK Test Client", redirect_host: "127.0.0.1:9" })
    ]);

    const refreshed = await json("/oauth/token", form({
      grant_type: "refresh_token",
      refresh_token: provider.saved!.refresh_token!,
      client_id: provider.information!.client_id
    }), false);
    expect(refreshed.status).toBe(200);
    const ping = (token: string) =>
      call("/mcp", { ...post({ jsonrpc: "2.0", id: 1, method: "ping" }), headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`
      } }, false);
    expect((await ping(provider.saved!.access_token)).status).toBe(401);
    expect((await ping(refreshed.body.access_token)).status).toBe(200);
    const reused = await json("/oauth/token", form({ grant_type: "refresh_token", refresh_token: provider.saved!.refresh_token! }), false);
    expect(reused.body.error).toBe("invalid_grant");

    const revoked = await json(`/api/oauth/grants/${grants.body.data[0].id}/revoke`, { method: "POST" });
    expect(revoked.status).toBe(200);
    const afterRevoke = await ping(refreshed.body.access_token);
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect((await json("/api/oauth/grants")).body.data).toEqual([]);
  });

  it("accepts each authorization code once and only with the matching PKCE verifier", async () => {
    const clientId = await registerTestClient();
    const { verifier, challenge } = pkce();
    const callback = await consentAndApprove({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-1"
    });
    const code = callback.searchParams.get("code")!;
    const exchange = (codeVerifier: string) =>
      json("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: codeVerifier, client_id: clientId, redirect_uri: CALLBACK }), false);
    expect((await exchange(pkce().verifier)).body.error).toBe("invalid_grant");
    const accepted = await exchange(verifier);
    expect(accepted.status).toBe(200);
    expect(accepted.body.access_token).toMatch(/^phosphene_oauth_at_/);
    expect((await exchange(verifier)).body.error).toBe("invalid_grant");
  });

  it("never redirects to an unregistered URI and reports protocol errors to the registered one", async () => {
    expect((await json("/oauth/register", post({ redirect_uris: ["http://evil.example/callback"] }), false)).body.error)
      .toBe("invalid_redirect_uri");
    const clientId = await registerTestClient();
    const { challenge } = pkce();
    const unregistered = await authorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://evil.example/callback",
      code_challenge: challenge,
      code_challenge_method: "S256"
    });
    expect(`${unregistered.pathname}${unregistered.search}`).toBe("/connect?error=invalid_redirect_uri");
    const withoutPkce = await authorize({ response_type: "code", client_id: clientId, redirect_uri: CALLBACK, state: "s" });
    expect(`${withoutPkce.origin}${withoutPkce.pathname}`).toBe(CALLBACK);
    expect(withoutPkce.searchParams.get("error")).toBe("invalid_request");
    expect(withoutPkce.searchParams.get("iss")).toBe(base);
    expect(withoutPkce.searchParams.get("state")).toBe("s");
  });

  it("requires a signed-in user to approve, but lets anyone decline", async () => {
    const clientId = await registerTestClient();
    const params = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      state: "deny-me"
    };
    const consent = await authorize(params);
    const requestId = consent.searchParams.get("request");
    expect((await call(`/api/oauth/requests/${requestId}/approve`, { method: "POST" }, false)).status).toBe(401);
    const denied = await json(`/api/oauth/requests/${requestId}/deny`, { method: "POST" }, false);
    const callback = new URL(denied.body.data.redirect_to);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("deny-me");
    expect((await json(`/api/oauth/requests/${requestId}`, {}, false)).status).toBe(404);
  });

  it("supports clients identified by a metadata document URL", async () => {
    const clientId = "https://client.example.com/oauth/client.json";
    const requests: http.IncomingMessage[] = [];
    serveMetadata((request, response) => {
      requests.push(request);
      response.writeHead(200, { "content-type": "application/json" }).end(metadataDocument(clientId));
    });
    const params = {
      response_type: "code",
      client_id: clientId,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256"
    };
    const consent = await authorize({ ...params, redirect_uri: "https://client.example.com/callback" });
    const details = await json(`/api/oauth/requests/${consent.searchParams.get("request")}`, {}, false);
    expect(details.body.data).toEqual({ client_name: "Metadata Client", redirect_host: "client.example.com" });
    const mismatch = await authorize({ ...params, redirect_uri: "https://client.example.com/other" });
    expect(mismatch.searchParams.get("error")).toBe("invalid_redirect_uri");
    expect(requests[0].url).toBe("/oauth/client.json");
    expect(requests[0].headers["accept-encoding"]).toBe("identity");
  });

  it("stops reading oversized metadata documents instead of buffering them", async () => {
    const params = {
      response_type: "code",
      client_id: "https://client.example.com/oauth/client.json",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256"
    };
    // One body declares a 50 MB length and the other declares none; both stream forever.
    for (const headers of [{ "content-length": String(50 * 1024 * 1024) }, {}]) {
      let hungUp!: Promise<void>;
      serveMetadata((_request, response) => {
        hungUp = closedByClient(response);
        response.writeHead(200, { "content-type": "application/json", ...headers });
        const chunk = " ".repeat(1024);
        const pump = () => {
          while (!response.destroyed && response.write(chunk));
          if (!response.destroyed) response.once("drain", pump);
        };
        response.write("{");
        pump();
      });
      const started = Date.now();
      expect((await authorize(params)).searchParams.get("error")).toBe("invalid_client");
      await hungUp;
      // Far sooner than the 5 s timeout, so the size limit is what ended the download.
      expect(Date.now() - started).toBeLessThan(2500);
    }
  });

  it("does not inflate compressed metadata documents past the size limit", async () => {
    const clientId = "https://client.example.com/oauth/client.json";
    const params = { response_type: "code", client_id: clientId, code_challenge: pkce().challenge, code_challenge_method: "S256" };
    let body = zlib.gzipSync(metadataDocument(clientId));
    serveMetadata((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }).end(body);
    });
    // A server that compresses although identity was requested still works for a normal document.
    expect((await authorize(params)).searchParams.get("request")).toBeTruthy();
    // A small gzip that would inflate to megabytes of otherwise valid JSON is refused.
    body = zlib.gzipSync(metadataDocument(clientId, { padding: " ".repeat(2 * 1024 * 1024) }));
    expect(body.length).toBeLessThan(8 * 1024);
    expect((await authorize(params)).searchParams.get("error")).toBe("invalid_client");
  });

  it("does not follow redirects from metadata document URLs", async () => {
    serveMetadata((_request, response) => {
      response.writeHead(302, { location: "https://client.example.com/elsewhere.json" }).end();
    });
    const location = await authorize({
      response_type: "code",
      client_id: "https://client.example.com/oauth/client.json",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256"
    });
    expect(location.searchParams.get("error")).toBe("invalid_client");
  });

  it("refuses metadata hosts that resolve to non-public addresses", async () => {
    let connections = 0;
    const listener = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const { port } = listener.address() as AddressInfo;
    const resolved = new Map([
      ["loopback.example.com", ["127.0.0.1"]],
      ["mapped.example.com", ["::ffff:127.0.0.1"]],
      ["cloud-metadata.example.com", ["169.254.169.254"]],
      ["private.example.com", ["10.0.0.8"]],
      ["unique-local.example.com", ["fd00::8"]],
      // Every address must be public, or a rebinding host could hand the private one to the connection.
      ["mixed.example.com", ["1.1.1.1", "127.0.0.1"]]
    ]);
    const realLookup = dns.lookup;
    vi.spyOn(dns, "lookup").mockImplementation(((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
      const addresses = resolved.get(hostname)?.map((address) => ({ address, family: net.isIP(address) }));
      if (!addresses) return realLookup(hostname, options, callback);
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }) as unknown as typeof dns.lookup);
    try {
      for (const hostname of resolved.keys()) {
        const clientId = `https://${hostname}:${port}/oauth/client.json`;
        expect(isClientMetadataDocumentUrl(clientId)).toBe(true);
        const location = await authorize({
          response_type: "code",
          client_id: clientId,
          code_challenge: pkce().challenge,
          code_challenge_method: "S256"
        });
        expect(location.searchParams.get("error")).toBe("invalid_client");
      }
      expect(dns.lookup).toHaveBeenCalledTimes(resolved.size);
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  it("treats only globally routable addresses as public", () => {
    for (const address of ["8.8.8.8", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "2606:4700:4700::1111"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "198.18.0.1",
      "203.0.113.5",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "::ffff:8.8.8.8",
      "64:ff9b::a9fe:a9fe",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "fe80::1%eth0",
      "ff02::1",
      "2001:db8::1",
      "2002:7f00:1::",
      "client.example.com",
      ""
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("only fetches metadata documents from public HTTPS URLs", () => {
    expect(isClientMetadataDocumentUrl("https://client.example.com/oauth/client.json")).toBe(true);
    for (const url of [
      "http://client.example.com/client.json",
      "https://client.example.com/",
      "https://127.0.0.1/client.json",
      "https://localhost/client.json",
      "https://[::1]/client.json",
      "https://intranet/client.json",
      "client_abc"
    ]) {
      expect(isClientMetadataDocumentUrl(url)).toBe(false);
    }
  });
});
