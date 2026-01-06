import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { listCachedEntities, upsertCachedEntities } from "@/cache/entities";
import { getCacheState, listCacheStates, setCacheState } from "@/cache/state";
import { openJournalDb } from "@/journal/db";

async function createTempDb() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nab-cache-"));
  return openJournalDb(path.join(dir, "nab.sqlite"));
}

test("upsertCachedEntities inserts and replaces by id", async () => {
  const db = await createTempDb();
  upsertCachedEntities(db, "b1", "tx", [
    { id: "t1", data: { memo: "a" } },
    { id: "t2", data: { memo: "b" } },
  ]);

  upsertCachedEntities(db, "b1", "tx", [{ id: "t1", data: { memo: "updated" } }]);

  const rows = listCachedEntities(db, "b1", "tx");
  expect(rows).toEqual([
    { id: "t1", data: { memo: "updated" } },
    { id: "t2", data: { memo: "b" } },
  ]);
});

test("cache state helpers read and write server knowledge", async () => {
  const db = await createTempDb();
  setCacheState(db, "b1", "transactions", 10);
  setCacheState(db, "b1", "accounts", 5);
  setCacheState(db, "b1", "transactions", 11);

  const txState = getCacheState(db, "b1", "transactions");
  expect(txState?.serverKnowledge).toBe(11);

  const all = listCacheStates(db, "b1");
  expect(all.map((row) => row.resource)).toEqual(["accounts", "transactions"]);
});
