import { describe, expect, it } from "vitest";
import {
  changePasswordSchema,
  loginSchema,
  newPasswordSchema,
  PASSWORD_CHARACTER_ERROR,
  setupSchema
} from "../src/shared/schemas";

describe("new password validation", () => {
  it.each([
    "abcdefghij", "ABCDEFGHIJ", "0123456789", "!@#$%^&*()",
    "Abc123!@#$", "a".repeat(256),
    Array.from({ length: 94 }, (_, index) => String.fromCharCode(0x21 + index)).join("")
  ])("accepts visible ASCII without requiring a character mix: %s", (password) => {
    expect(newPasswordSchema.parse(password)).toBe(password);
    expect(setupSchema.parse({ password, timezone: "Asia/Shanghai" }).password).toBe(password);
    expect(changePasswordSchema.parse({ current_password: "旧密码", new_password: password }).new_password).toBe(password);
  });

  it.each([
    ["space", " "], ["tab", "\t"], ["LF", "\n"], ["CRLF", "\r\n"],
    ["Chinese", "中"], ["fullwidth letter", "Ａ"], ["fullwidth digit", "１"],
    ["fullwidth punctuation", "！"], ["curly quote", "’"], ["accent", "é"],
    ["emoji", "🐈"], ["ideographic space", "\u3000"], ["NBSP", "\u00a0"],
    ["zero-width space", "\u200b"], ["BOM", "\ufeff"], ["NUL", "\u0000"],
    ["DEL", "\u007f"], ["bidi mark", "\u200e"]
  ])("rejects %s anywhere without normalizing the input", (_label, character) => {
    for (const password of [`${character}abcdefghij`, `abcde${character}fghij`, `abcdefghij${character}`]) {
      const result = newPasswordSchema.safeParse(password);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0].message).toBe(PASSWORD_CHARACTER_ERROR);
      expect(setupSchema.safeParse({ password, timezone: "Asia/Shanghai" }).success).toBe(false);
      expect(changePasswordSchema.safeParse({ current_password: "old", new_password: password }).success).toBe(false);
    }
  });

  it.each(["", "a".repeat(9), "a".repeat(257)])("preserves length limits", (password) => {
    expect(newPasswordSchema.safeParse(password).success).toBe(false);
  });

  it("does not apply the new character rules to existing passwords", () => {
    const oldPassword = "旧密码Ａ！\u200b ";
    expect(loginSchema.parse({ password: oldPassword }).password).toBe(oldPassword);
    expect(changePasswordSchema.parse({ current_password: oldPassword, new_password: "0123456789" }).current_password).toBe(oldPassword);
  });
});
