import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { getSqlitePath } from "@/config/paths";
import { applyMigrations } from "./migrations";

export async function openJournalDb(dbPath: string = getSqlitePath()): Promise<Database> {
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  applyMigrations(db);
  return db;
}
