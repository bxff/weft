import type { Database } from "bun:sqlite";

/** Keep FULL enabled through the caller's synchronous, top-level commit. */
export function withFullDurability<T>(
  db: Database, publish: () => T, mode: "FULL" | "at-least-FULL" = "FULL",
): T {
  if (db.inTransaction) throw new Error("Durable publication requires its own transaction");
  const previous = db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()!.synchronous;
  if (previous === 2 || (mode === "at-least-FULL" && previous > 2)) return publish();
  db.run("PRAGMA synchronous = FULL");
  try {
    return publish();
  } finally {
    db.run(`PRAGMA synchronous = ${previous}`);
  }
}
