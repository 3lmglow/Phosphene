import type { Request } from "express";

export function publicOrigin(request: Request): string {
  return `${request.protocol}://${request.get("host")}`;
}

export function protectedResourceMetadataUrl(request: Request): string {
  return `${publicOrigin(request)}/.well-known/oauth-protected-resource/mcp`;
}
