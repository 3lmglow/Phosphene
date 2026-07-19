import { initializeDatabase, shutdownDatabase } from "./client";

await initializeDatabase();
console.log("Phosphene database migrations are up to date.");
await shutdownDatabase();
