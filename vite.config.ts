import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@web": fileURLToPath(new URL("./src/web", import.meta.url))
    }
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    sourcemap: true
  },
  server: {
    port: 5173
  }
});
