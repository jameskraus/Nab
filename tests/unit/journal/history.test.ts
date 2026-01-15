import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { openJournalDb } from "@/journal/db";
import {
  getHistoryAction,
  getHistoryActionByIndex,
  listHistoryActions,
  recordHistoryAction,
} from "@/journal/history";

async function createTempDb() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nab-history-"));
  return openJournalDb(path.join(dir, "nab.sqlite"));
}

test("recordHistoryAction stores payload and inverse patch", async () => {
  const db = await createTempDb();
  const payload = {
    argv: { id: ["t1"], memo: "hello" },
    txIds: ["t1"],
    patches: [{ id: "t1", patch: { memo: "hello" } }],
  };
  const inversePatch = [{ id: "t1", patch: { memo: null } }];

  const inserted = recordHistoryAction(db, "tx.memo.set", payload, inversePatch);

  const actions = listHistoryActions(db, { limit: 10 });
  expect(actions[0]?.id).toBe(inserted.id);
  expect(actions[0]?.payload.txIds).toEqual(["t1"]);
  expect(actions[0]?.inversePatch).toEqual(inversePatch);

  const fetched = getHistoryAction(db, inserted.id);
  expect(fetched?.id).toBe(inserted.id);
  expect(fetched?.payload.txIds).toEqual(["t1"]);
  expect(fetched?.inversePatch).toEqual(inversePatch);
});

test("listHistoryActions respects since and limit filters", async () => {
  const db = await createTempDb();
  const first = recordHistoryAction(db, "tx.memo.set", {
    argv: { id: ["t1"] },
    txIds: ["t1"],
  });
  db.query("update history_actions set created_at = ? where id = ?").run(
    "2000-01-01T00:00:00Z",
    first.id,
  );

  const second = recordHistoryAction(db, "tx.memo.clear", {
    argv: { id: ["t2"] },
    txIds: ["t2"],
  });

  const filtered = listHistoryActions(db, { since: "2001-01-01T00:00:00Z" });
  expect(filtered.map((action) => action.id)).toEqual([second.id]);

  const limited = listHistoryActions(db, { limit: 1 });
  expect(limited).toHaveLength(1);
});

test("getHistoryActionByIndex returns the most recent action by index", async () => {
  const db = await createTempDb();
  const oldest = recordHistoryAction(db, "tx.memo.set", {
    argv: { id: ["t1"] },
    txIds: ["t1"],
  });
  const middle = recordHistoryAction(db, "tx.memo.clear", {
    argv: { id: ["t2"] },
    txIds: ["t2"],
  });
  const newest = recordHistoryAction(db, "tx.approve", {
    argv: { id: ["t3"] },
    txIds: ["t3"],
  });

  db.query("update history_actions set created_at = ? where id = ?").run(
    "2000-01-01T00:00:00Z",
    oldest.id,
  );
  db.query("update history_actions set created_at = ? where id = ?").run(
    "2001-01-01T00:00:00Z",
    middle.id,
  );
  db.query("update history_actions set created_at = ? where id = ?").run(
    "2002-01-01T00:00:00Z",
    newest.id,
  );

  expect(getHistoryActionByIndex(db, 0)?.id).toBe(newest.id);
  expect(getHistoryActionByIndex(db, 1)?.id).toBe(middle.id);
  expect(getHistoryActionByIndex(db, 2)?.id).toBe(oldest.id);
  expect(getHistoryActionByIndex(db, 3)).toBeNull();
});
