import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@server": fileURLToPath(new URL("./src/server", import.meta.url)),
      "@web": fileURLToPath(new URL("./src/web", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    env: {
      NODE_ENV: "test",
      PGLITE_PATH: "memory://",
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_PATH: ".data/test-uploads"
    },
    sequence: {
      concurrent: false
    },
    coverage: {
      reporter: ["text", "html"],
      exclude: ["src/web/main.tsx", "src/server/index.ts"]
    }
  }
});
