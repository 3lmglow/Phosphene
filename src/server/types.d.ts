import type { SessionRow } from "./db/schema";

declare global {
  namespace Express {
    interface Request {
      phospheneSession?: SessionRow;
      phospheneActor?: "AI" | "user";
    }
  }
}

export {};
