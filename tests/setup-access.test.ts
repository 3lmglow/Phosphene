import { describe, expect, it } from "vitest";
import { acceptsSetupToken } from "../src/server/lib/setup-access";

describe("first-time setup access", () => {
  it("allows the first visitor when no setup token was configured", () => {
    expect(acceptsSetupToken(undefined, "")).toBe(true);
    expect(acceptsSetupToken(undefined, "anything")).toBe(true);
  });

  it("rejects a missing or incorrect token when protection is enabled", () => {
    expect(acceptsSetupToken("private-owner-token", "")).toBe(false);
    expect(acceptsSetupToken("private-owner-token", "private-owner-taken")).toBe(false);
  });

  it("accepts the exact configured token", () => {
    expect(acceptsSetupToken("private-owner-token", "private-owner-token")).toBe(true);
  });
});
