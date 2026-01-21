import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { normalizeRefs, resolveSelectorIds } from "@/cli/txSelectors";
import { openJournalDb } from "@/journal/db";
import { getOrCreateRef } from "@/refs/refLease";

test("normalizeRefs trims, canonicalizes, dedupes, and drops blanks", () => {
  expect(normalizeRefs([" a ", "", "a", "b"])).toEqual(["A", "B"]);
});

test("normalizeRefs canonicalizes aliases and strips leading zeros", () => {
  expect(normalizeRefs(["o1", "01", "1", "O1"])).toEqual(["1"]);
});

test("resolveSelectorIds rejects mixed id and ref", () => {
  expect(() => resolveSelectorIds(undefined, { id: "one", ref: "R1" })).toThrow(
    "either --id or --ref",
  );
});

test("resolveSelectorIds rejects missing selectors", () => {
  expect(() => resolveSelectorIds(undefined, {})).toThrow("at least one");
});

test("resolveSelectorIds resolves ref via db", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "nab-ref-test-"));
  const db = await openJournalDb(path.join(tmp, "nab.sqlite"));
  const ref = getOrCreateRef(db, "uuid-1");
  expect(resolveSelectorIds(db, { ref })).toEqual(["uuid-1"]);
  db.close();
});

test("resolveSelectorIds rejects invalid ref", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "nab-ref-test-"));
  const db = await openJournalDb(path.join(tmp, "nab.sqlite"));
  expect(() => resolveSelectorIds(db, { ref: "*" })).toThrow(
    "Allowed: 0123456789ABCDEFGHJKMNPQRSTVWXYZ",
  );
  db.close();
});

test("resolveSelectorIds rejects unknown ref", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "nab-ref-test-"));
  const db = await openJournalDb(path.join(tmp, "nab.sqlite"));
  expect(() => resolveSelectorIds(db, { ref: "A" })).toThrow("Ref not found");
  db.close();
});
