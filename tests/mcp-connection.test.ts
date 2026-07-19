import { describe, expect, it } from "vitest";
import {
  authorizationHeaderForToken,
  normalizeMcpEndpoint,
  readMcpToken
} from "../src/server/lib/mcp-connection";

describe("MCP connection compatibility", () => {
  it("keeps Authorization Bearer as the primary credential", () => {
    expect(readMcpToken("Bearer phosphene_ai_primary", undefined)).toEqual({
      token: "phosphene_ai_primary",
      conflicting: false
    });
    expect(readMcpToken("bearer phosphene_ai_lowercase", undefined)).toEqual({
      token: "phosphene_ai_lowercase",
      conflicting: false
    });
  });

  it("accepts the dedicated Phosphene header", () => {
    expect(readMcpToken(undefined, " phosphene_ai_direct ")).toEqual({
      token: "phosphene_ai_direct",
      conflicting: false
    });
  });

  it("rejects two different credentials instead of choosing silently", () => {
    expect(
      readMcpToken(
        "Bearer phosphene_ai_authorization",
        "phosphene_ai_custom"
      )
    ).toEqual({
      token: "phosphene_ai_authorization",
      conflicting: true
    });
  });

  it("builds a bearer header without adding the scheme twice", () => {
    expect(authorizationHeaderForToken("phosphene_ai_raw")).toBe(
      "Bearer phosphene_ai_raw"
    );
    expect(authorizationHeaderForToken("Bearer phosphene_ai_ready")).toBe(
      "Bearer phosphene_ai_ready"
    );
    expect(authorizationHeaderForToken("")).toBeUndefined();
  });

  it("adds /mcp when the stdio bridge receives only an origin", () => {
    expect(normalizeMcpEndpoint("https://phosphene.example").toString()).toBe(
      "https://phosphene.example/mcp"
    );
    expect(
      normalizeMcpEndpoint("http://127.0.0.1:8080/mcp/").toString()
    ).toBe("http://127.0.0.1:8080/mcp");
  });

  it("does not allow credentials to leak through the MCP URL", () => {
    expect(() =>
      normalizeMcpEndpoint("https://user:secret@phosphene.example/mcp")
    ).toThrow(/credentials/i);
    expect(() =>
      normalizeMcpEndpoint(
        "https://phosphene.example/mcp?token=phosphene_ai_secret"
      )
    ).toThrow(/query parameters/i);
  });
});
