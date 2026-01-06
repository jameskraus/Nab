import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { openJournalDb } from "@/journal/db";

test("journal db initializes with expected tables", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "nab-db-test-"));
  const dbPath = path.join(tmp, "nab.sqlite");

  const db = await openJournalDb(dbPath);

  const table = (name: string) =>
    db
      .query<{ name: string }, [string]>(
        "select name from sqlite_master where type='table' and name=?",
      )
      .get(name);

  expect(table("schema_migrations")).toBeTruthy();
  expect(table("schema_version")).toBeTruthy();
  expect(table("history_actions")).toBeTruthy();
  expect(table("cache_entities")).toBeTruthy();
  expect(table("cache_state")).toBeTruthy();

  const version = db
    .query<{ version: string }, []>("select version from schema_version where id = 1")
    .get();
  expect(version?.version).toBe("001_init");

  const pragma = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
  expect(pragma?.foreign_keys).toBe(1);

  db.close();
});

test("journal migrations are idempotent", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "nab-db-test-"));
  const dbPath = path.join(tmp, "nab.sqlite");

  const first = await openJournalDb(dbPath);
  first.close();

  const second = await openJournalDb(dbPath);
  const count = second
    .query<{ count: number }, []>("select count(*) as count from schema_migrations")
    .get();
  expect(count?.count).toBe(1);
  const version = second
    .query<{ version: string }, []>("select version from schema_version where id = 1")
    .get();
  expect(version?.version).toBe("001_init");
  second.close();
});
