import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSetupToken } from "../src/server/lib/runtime-secrets";

const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phosphene-runtime-secrets-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("production setup token", () => {
  it("generates a strong token and reuses it from the persistent data directory", () => {
    const dataDir = temporaryDirectory();
    const first = resolveSetupToken({
      nodeEnv: "production",
      dataDir,
      randomSecret: () => "a".repeat(43)
    });
    const second = resolveSetupToken({
      nodeEnv: "production",
      dataDir,
      randomSecret: () => "b".repeat(43)
    });

    expect(first.source).toBe("generated");
    expect(second.source).toBe("persistent_file");
    expect(second.value).toBe(first.value);
    expect(fs.readFileSync(path.join(dataDir, ".phosphene-setup-token"), "utf8")).toBe(first.value);
  });

  it("replaces an explicitly weak or placeholder token instead of crash-looping", () => {
    const resolved = resolveSetupToken({
      nodeEnv: "production",
      dataDir: temporaryDirectory(),
      configuredToken: "short",
      randomSecret: () => "c".repeat(43)
    });

    expect(resolved.source).toBe("generated");
    expect(resolved.rejectedConfiguredToken).toBe(true);
    expect(resolved.value).toBe("c".repeat(43));
  });

  it("uses a strong configured token without writing it to disk", () => {
    const dataDir = temporaryDirectory();
    const configuredToken = `configured-${"d".repeat(32)}`;
    const resolved = resolveSetupToken({
      nodeEnv: "production",
      dataDir,
      configuredToken
    });

    expect(resolved.source).toBe("environment");
    expect(resolved.value).toBe(configuredToken);
    expect(fs.existsSync(path.join(dataDir, ".phosphene-setup-token"))).toBe(false);
  });

  it("keeps the predictable local token outside production", () => {
    const resolved = resolveSetupToken({
      nodeEnv: "test",
      dataDir: temporaryDirectory()
    });

    expect(resolved.source).toBe("development_default");
    expect(resolved.value).toBe("phosphene-local-setup");
  });
});
