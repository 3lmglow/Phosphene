import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { publicOrigin } from "./lib/origin";
import {
  authorizationServerMetadata,
  exchangeToken,
  OAuthError,
  protectedResourceMetadata,
  registerClient,
  revokeToken,
  startAuthorization
} from "./services/oauth";

const router = Router();
const limiter = (limit: number, windowMs = 15 * 60 * 1000) =>
  rateLimit({ windowMs, limit, standardHeaders: "draft-8", legacyHeaders: false });

function allowCrossOrigin(request: Request, response: Response, next: NextFunction) {
  response.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
    "Cross-Origin-Resource-Policy": "cross-origin"
  });
  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }
  next();
}

function protocolRoute(handler: (request: Request, response: Response) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch((error) => {
      if (!(error instanceof OAuthError)) {
        next(error);
        return;
      }
      response
        .status(error.status)
        .set({ "Cache-Control": "no-store", Pragma: "no-cache" })
        .json({ error: error.error, error_description: error.description });
    });
  };
}

router.use(["/.well-known", "/oauth/token", "/oauth/register", "/oauth/revoke"], allowCrossOrigin);

router.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (request, response) => {
  response.json(protectedResourceMetadata(publicOrigin(request)));
});

router.get("/.well-known/oauth-authorization-server", (request, response) => {
  response.json(authorizationServerMetadata(publicOrigin(request)));
});

router.use("/.well-known", (_request, response) => {
  response.status(404).json({ error: "not_found" });
});

router.get(
  "/oauth/authorize",
  limiter(60),
  protocolRoute(async (request, response) => {
    const query = Object.fromEntries(
      Object.entries(request.query).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
    const result = await startAuthorization(query, publicOrigin(request));
    response.set("Cache-Control", "no-store");
    if (result.kind === "redirect") response.redirect(302, result.location);
    else if (result.kind === "consent") response.redirect(302, `/connect?request=${encodeURIComponent(result.requestId)}`);
    else response.redirect(302, `/connect?error=${result.error}`);
  })
);

router.post(
  "/oauth/token",
  limiter(60),
  protocolRoute(async (request, response) => {
    const tokens = await exchangeToken(request.body ?? {}, publicOrigin(request));
    response.set({ "Cache-Control": "no-store", Pragma: "no-cache" }).json(tokens);
  })
);

router.post(
  "/oauth/register",
  limiter(10, 60 * 60 * 1000),
  protocolRoute(async (request, response) => {
    response.status(201).set("Cache-Control", "no-store").json(await registerClient(request.body));
  })
);

router.post(
  "/oauth/revoke",
  limiter(60),
  protocolRoute(async (request, response) => {
    await revokeToken(request.body ?? {});
    response.sendStatus(200);
  })
);

export default router;
