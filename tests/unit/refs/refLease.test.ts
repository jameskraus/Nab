import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { openJournalDb } from "@/journal/db";
import { getOrCreateRef, getOrCreateRefs, resolveRef } from "@/refs/refLease";

async function openTempDb() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "nab-ref-test-"));
  const dbPath = path.join(tmp, "nab.sqlite");
  return openJournalDb(dbPath);
}

test("getOrCreateRef returns same ref within lease", async () => {
  const db = await openTempDb();
  const ref1 = getOrCreateRef(db, "uuid-1", { nowMs: 1000, leaseMs: 1000 });
  const ref2 = getOrCreateRef(db, "uuid-1", { nowMs: 1500, leaseMs: 1000 });
  expect(ref2).toBe(ref1);
  db.close();
});

test("getOrCreateRef mints a new ref after expiration", async () => {
  const db = await openTempDb();
  const ref1 = getOrCreateRef(db, "uuid-1", { nowMs: 0, leaseMs: 1000 });
  const ref2 = getOrCreateRef(db, "uuid-1", { nowMs: 1001, leaseMs: 1000 });
  expect(ref2).not.toBe(ref1);
  db.close();
});

test("resolveRef returns uuid when active", async () => {
  const db = await openTempDb();
  const ref = getOrCreateRef(db, "uuid-2", { nowMs: 0, leaseMs: 1000 });
  expect(resolveRef(db, ref, { nowMs: 500, leaseMs: 1000 })).toBe("uuid-2");
  db.close();
});

test("resolveRef returns null when expired", async () => {
  const db = await openTempDb();
  const ref = getOrCreateRef(db, "uuid-3", { nowMs: 0, leaseMs: 1000 });
  expect(resolveRef(db, ref, { nowMs: 1001, leaseMs: 1000 })).toBeNull();
  db.close();
});

test("getOrCreateRefs returns refs for all uuids", async () => {
  const db = await openTempDb();
  const refs = getOrCreateRefs(db, ["uuid-a", "uuid-b", "uuid-a"], {
    nowMs: 0,
    leaseMs: 1000,
  });
  expect(refs.size).toBe(2);
  expect(refs.get("uuid-a")).toBeTruthy();
  expect(refs.get("uuid-b")).toBeTruthy();
  db.close();
});

test("getOrCreateRefs handles batches larger than the default size", async () => {
  const db = await openTempDb();
  const uuids = Array.from({ length: 600 }, (_, index) => `uuid-${index}`);
  const refs = getOrCreateRefs(db, uuids, { nowMs: 0, leaseMs: 1000 });
  expect(refs.size).toBe(600);
  expect(refs.get("uuid-0")).toBeTruthy();
  expect(refs.get("uuid-599")).toBeTruthy();
  db.close();
});
