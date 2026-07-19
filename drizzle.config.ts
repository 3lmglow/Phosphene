import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.SQLITE_PATH ?? ".data/phosphene.sqlite"
  },
  strict: true,
  verbose: true
});
