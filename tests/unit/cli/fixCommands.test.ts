import { afterAll, expect, test } from "bun:test";
import type { Account, TransactionDetail } from "ynab";

import { NotFoundError } from "@/api/errors";
import { type FixMislinkedTransferContext, runFixMislinkedTransfer } from "@/cli/commands/fix";
import { openJournalDb } from "@/journal/db";
import { listHistoryActions } from "@/journal/history";
import { acc, linkedTransferPair, tx } from "../../helpers/ynabFixtures";

const ORIGINAL_POLL_DELAY = process.env.NAB_RELINK_POLL_DELAY_MS;
process.env.NAB_RELINK_POLL_DELAY_MS = "0";

afterAll(() => {
  if (ORIGINAL_POLL_DELAY === undefined) {
    process.env.NAB_RELINK_POLL_DELAY_MS = undefined;
  } else {
    process.env.NAB_RELINK_POLL_DELAY_MS = ORIGINAL_POLL_DELAY;
  }
});

type ClearedStatus = TransactionDetail["cleared"];

type FixFixture = {
  accounts: Account[];
  transactions: Map<string, TransactionDetail>;
  anchor: TransactionDetail;
  phantom: TransactionDetail;
  orphan: TransactionDetail;
  anchorAccount: Account;
};

type TransactionUpdate = Parameters<FixMislinkedTransferContext["ynab"]["updateTransaction"]>[2];
type YnabCall =
  | { method: "updateTransaction"; id: string; patch: TransactionUpdate }
  | { method: "deleteTransaction"; id: string };

const FIX_ARGS = {
  anchor: "anchor-id",
  phantom: "phantom-id",
  orphan: "orphan-id",
  yes: true,
  format: "json",
};
const MIRROR_ID = "anchor-mirror-id";

async function withCapturedStdout(run: () => Promise<void>): Promise<string> {
  let data = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown) => {
    data += String(chunk);
    return true;
  };
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return data;
}

function buildFixFixture({
  anchorCleared = "cleared",
  phantomCleared = "uncleared",
  orphanCleared = "cleared",
  anchorDeleted = false,
  phantomDeleted = false,
  orphanDeleted = false,
  anchorAccountDeleted = false,
  phantomAccountDeleted = false,
  orphanAccountDeleted = false,
}: {
  anchorCleared?: ClearedStatus;
  phantomCleared?: ClearedStatus;
  orphanCleared?: ClearedStatus;
  anchorDeleted?: boolean;
  phantomDeleted?: boolean;
  orphanDeleted?: boolean;
  anchorAccountDeleted?: boolean;
  phantomAccountDeleted?: boolean;
  orphanAccountDeleted?: boolean;
} = {}): FixFixture {
  const anchorAccount = acc({
    id: "acc-credit",
    name: "Credit",
    type: "creditCard",
    transfer_payee_id: "payee-credit",
    deleted: anchorAccountDeleted,
  });
  const phantomAccount = acc({
    id: "acc-phantom",
    name: "Phantom Checking",
    type: "checking",
    transfer_payee_id: "payee-phantom",
    deleted: phantomAccountDeleted,
  });
  const orphanAccount = acc({
    id: "acc-orphan",
    name: "Orphan Checking",
    type: "checking",
    transfer_payee_id: "payee-orphan",
    deleted: orphanAccountDeleted,
  });

  const { anchor, phantom } = linkedTransferPair({
    anchor: {
      id: FIX_ARGS.anchor,
      account_name: anchorAccount.name,
      amount: 100000,
      cleared: anchorCleared,
      import_id: "YNAB:100000:2026-01-22:1",
      deleted: anchorDeleted,
    },
    phantom: {
      id: FIX_ARGS.phantom,
      account_name: phantomAccount.name,
      amount: -100000,
      cleared: phantomCleared,
      import_id: null,
      deleted: phantomDeleted,
    },
    anchorAccount,
    phantomAccount,
  });

  const orphan = tx({
    id: FIX_ARGS.orphan,
    account_id: orphanAccount.id,
    account_name: orphanAccount.name,
    amount: -100000,
    cleared: orphanCleared,
    import_id: "YNAB:-100000:2026-01-22:1",
    transfer_account_id: null,
    transfer_transaction_id: null,
    deleted: orphanDeleted,
  });

  const transactions = new Map<string, TransactionDetail>([
    [anchor.id, anchor],
    [phantom.id, phantom],
    [orphan.id, orphan],
  ]);

  return {
    accounts: [anchorAccount, phantomAccount, orphanAccount],
    transactions,
    anchor,
    phantom,
    orphan,
    anchorAccount,
  };
}

function createYnabStub(
  fixture: FixFixture,
  options: {
    relink?: "reuse-anchor" | "new-mirror" | "none";
    afterRelink?: () => void;
    afterDelete?: () => void;
    failUpdateId?: string;
    failDelete?: boolean;
    ignoreMirrorUpdate?: boolean;
  } = {},
): { ynab: FixMislinkedTransferContext["ynab"]; calls: YnabCall[] } {
  const calls: YnabCall[] = [];
  const relink = options.relink ?? "reuse-anchor";

  const ynab = {
    getTransaction: async (_budgetId: string, id: string) => {
      const tx = fixture.transactions.get(id);
      if (!tx) throw new NotFoundError({ detail: `Missing transaction: ${id}` });
      return tx;
    },
    listAccounts: async () => fixture.accounts,
    updateTransaction: async (_budgetId: string, id: string, patch: TransactionUpdate) => {
      calls.push({ method: "updateTransaction", id, patch });
      if (id === options.failUpdateId) throw new Error("Update failed");
      const current = fixture.transactions.get(id);
      if (!current) throw new Error(`Missing transaction: ${id}`);
      if (id === MIRROR_ID && options.ignoreMirrorUpdate) return current;
      let updated = { ...current, ...patch } as TransactionDetail;

      if (id === fixture.orphan.id && relink !== "none") {
        const counterpartId = relink === "new-mirror" ? MIRROR_ID : fixture.anchor.id;
        updated = {
          ...updated,
          transfer_account_id: fixture.anchor.account_id,
          transfer_transaction_id: counterpartId,
        };
        if (relink === "reuse-anchor") {
          fixture.transactions.set(fixture.phantom.id, {
            ...fixture.phantom,
            transfer_account_id: null,
            transfer_transaction_id: null,
          });
        }
        // Model the observed replacement: no import ID, orphan date, initially uncleared.
        fixture.transactions.set(counterpartId, {
          ...fixture.anchor,
          id: counterpartId,
          ...(relink === "new-mirror"
            ? { import_id: null, date: fixture.orphan.date, cleared: "uncleared" as const }
            : {}),
          transfer_account_id: fixture.orphan.account_id,
          transfer_transaction_id: fixture.orphan.id,
        });
      }

      fixture.transactions.set(id, updated);
      if (id === fixture.orphan.id) options.afterRelink?.();
      return updated;
    },
    deleteTransaction: async (_budgetId: string, id: string) => {
      calls.push({ method: "deleteTransaction", id });
      if (options.failDelete) throw new Error("Delete failed");
      const current = fixture.transactions.get(id);
      if (!current) throw new Error(`Missing transaction: ${id}`);
      fixture.transactions.delete(id);
      if (current.transfer_transaction_id) {
        fixture.transactions.delete(current.transfer_transaction_id);
      }
      options.afterDelete?.();
      return { ...current, deleted: true };
    },
  };

  return { ynab, calls };
}

function expectUpdateThenDelete(
  calls: YnabCall[],
  {
    orphanId,
    phantomId,
    payeeId,
    anchorId,
  }: { orphanId: string; phantomId: string; payeeId: string; anchorId: string },
): void {
  expect(calls).toHaveLength(2);
  expect(calls[0]?.method).toBe("updateTransaction");
  expect(calls[0]?.id).toBe(orphanId);
  if (calls[0]?.method === "updateTransaction") {
    expect(calls[0].patch.payee_id).toBe(payeeId);
  }
  expect(calls[1]?.method).toBe("deleteTransaction");
  expect(calls[1]?.id).toBe(phantomId);
  expect(calls.some((call) => call.method === "updateTransaction" && call.id === anchorId)).toBe(
    false,
  );
}

const successCases: Array<{
  name: string;
  anchorCleared: ClearedStatus;
  orphanCleared: ClearedStatus;
}> = [
  {
    name: "cleared anchor and orphan",
    anchorCleared: "cleared",
    orphanCleared: "cleared",
  },
  {
    name: "reconciled anchor and orphan",
    anchorCleared: "reconciled",
    orphanCleared: "reconciled",
  },
];

for (const testCase of successCases) {
  test(`fix mislinked-transfer updates orphan payee then deletes phantom (${testCase.name})`, async () => {
    const fixture = buildFixFixture({
      anchorCleared: testCase.anchorCleared,
      orphanCleared: testCase.orphanCleared,
    });
    const { ynab, calls } = createYnabStub(fixture);

    await withCapturedStdout(() =>
      runFixMislinkedTransfer(FIX_ARGS, {
        ynab,
        budgetId: "budget-1",
      }),
    );

    expectUpdateThenDelete(calls, {
      orphanId: fixture.orphan.id,
      phantomId: fixture.phantom.id,
      payeeId: fixture.anchorAccount.transfer_payee_id ?? "",
      anchorId: fixture.anchor.id,
    });
    expect(fixture.transactions.get(fixture.anchor.id)?.transfer_transaction_id).toBe(
      fixture.orphan.id,
    );
    expect(fixture.transactions.has(fixture.phantom.id)).toBe(false);
  });
}

test("fix mislinked-transfer rejects reconciled phantom", async () => {
  const fixture = buildFixFixture({ phantomCleared: "reconciled" });
  const { ynab, calls } = createYnabStub(fixture);

  const outcome = withCapturedStdout(() =>
    runFixMislinkedTransfer(FIX_ARGS, {
      ynab,
      budgetId: "budget-1",
    }),
  );

  await expect(outcome).rejects.toThrow("Phantom must have no import_id and be uncleared.");
  expect(calls).toHaveLength(0);
});

test("fix mislinked-transfer aborts if phantom remains linked to anchor", async () => {
  const fixture = buildFixFixture();
  const { ynab, calls } = createYnabStub(fixture, { relink: "none" });

  const outcome = withCapturedStdout(() =>
    runFixMislinkedTransfer(FIX_ARGS, {
      ynab,
      budgetId: "budget-1",
    }),
  );

  await expect(outcome).rejects.toThrow("Orphan did not receive a transfer counterpart");
  await expect(outcome).rejects.toThrow("do not blindly retry or delete");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.method).toBe("updateTransaction");
  expect(calls[0]?.id).toBe(fixture.orphan.id);
  expect(calls.some((call) => call.method === "deleteTransaction")).toBe(false);
});

for (const anchorCleared of ["cleared", "reconciled"] as const) {
  test(`fix preserves ${anchorCleared} anchor state on a new mirror and removes old pair`, async () => {
    const fixture = buildFixFixture({
      anchorCleared,
      orphanCleared: anchorCleared === "cleared" ? "reconciled" : "cleared",
    });
    fixture.orphan.date = "2026-01-25";
    const { ynab, calls } = createYnabStub(fixture, { relink: "new-mirror" });
    const output = await withCapturedStdout(() =>
      runFixMislinkedTransfer(FIX_ARGS, { ynab, budgetId: "budget-1" }),
    );

    expect(calls).toEqual([
      { method: "updateTransaction", id: fixture.orphan.id, patch: { payee_id: "payee-credit" } },
      { method: "updateTransaction", id: MIRROR_ID, patch: { cleared: anchorCleared } },
      { method: "deleteTransaction", id: fixture.phantom.id },
    ]);
    expect(fixture.transactions.get(MIRROR_ID)).toMatchObject({
      account_id: fixture.anchor.account_id,
      transfer_transaction_id: fixture.orphan.id,
      amount: -fixture.orphan.amount,
      cleared: anchorCleared,
      date: fixture.orphan.date,
      import_id: null,
    });
    expect(fixture.transactions.get(fixture.orphan.id)).toMatchObject({
      date: fixture.orphan.date,
      amount: fixture.orphan.amount,
      import_id: fixture.orphan.import_id,
      cleared: fixture.orphan.cleared,
      approved: fixture.orphan.approved,
      transfer_transaction_id: MIRROR_ID,
    });
    expect(fixture.transactions.has(fixture.anchor.id)).toBe(false);
    expect(fixture.transactions.has(fixture.phantom.id)).toBe(false);
    expect(JSON.parse(output).at(-1)).toMatchObject({
      action: "verify-repair",
      status: "verified",
    });
  });
}

test("fix skips a redundant mirror clearing update", async () => {
  const fixture = buildFixFixture();
  const { ynab, calls } = createYnabStub(fixture, {
    relink: "new-mirror",
    afterRelink: () => {
      const mirror = fixture.transactions.get(MIRROR_ID);
      if (!mirror) throw new Error("Missing mirror fixture");
      fixture.transactions.set(MIRROR_ID, { ...mirror, cleared: fixture.anchor.cleared });
    },
  });
  await withCapturedStdout(() => runFixMislinkedTransfer(FIX_ARGS, { ynab, budgetId: "budget-1" }));
  expect(calls.filter((call) => call.method === "updateTransaction")).toHaveLength(1);
});

const invalidMirrorCases: Array<[string, Partial<TransactionDetail> | null]> = [
  ["missing", null],
  ["deleted", { deleted: true }],
  ["wrong account", { account_id: "other-account" }],
  ["wrong amount", { amount: 200000 }],
  ["wrong transaction link", { transfer_transaction_id: "unrelated-transaction" }],
  ["wrong account link", { transfer_account_id: "unrelated-account" }],
  [
    "split",
    { subtransactions: [{ id: "split-id" } as TransactionDetail["subtransactions"][number]] },
  ],
];
for (const [name, overrides] of invalidMirrorCases) {
  test(`fix refuses cleanup when the new mirror is ${name}`, async () => {
    const fixture = buildFixFixture();
    const { ynab, calls } = createYnabStub(fixture, {
      relink: "new-mirror",
      afterRelink: () => {
        if (overrides === null) fixture.transactions.delete(MIRROR_ID);
        else {
          const mirror = fixture.transactions.get(MIRROR_ID);
          if (!mirror) throw new Error("Missing mirror fixture");
          fixture.transactions.set(MIRROR_ID, { ...mirror, ...overrides });
        }
      },
    });
    await expect(
      withCapturedStdout(() => runFixMislinkedTransfer(FIX_ARGS, { ynab, budgetId: "budget-1" })),
    ).rejects.toThrow("Repair may be partially applied");
    expect(calls).toHaveLength(1);
    expect(fixture.transactions.has(fixture.phantom.id)).toBe(true);
    expect(fixture.transactions.has(fixture.anchor.id)).toBe(true);
  });
}

test("fix refuses cleanup when the phantom now links to the new pair", async () => {
  const fixture = buildFixFixture();
  const { ynab, calls } = createYnabStub(fixture, {
    relink: "new-mirror",
    afterRelink: () =>
      fixture.transactions.set(fixture.phantom.id, {
        ...fixture.phantom,
        transfer_transaction_id: MIRROR_ID,
      }),
  });
  await expect(
    withCapturedStdout(() => runFixMislinkedTransfer(FIX_ARGS, { ynab, budgetId: "budget-1" })),
  ).rejects.toThrow("not linked to each other");
  expect(calls).toHaveLength(1);
});

test("fix refuses cleanup if a reused anchor is still linked from the phantom", async () => {
  const fixture = buildFixFixture();
  const { ynab, calls } = createYnabStub(fixture, {
    afterRelink: () => fixture.transactions.set(fixture.phantom.id, fixture.phantom),
  });
  await expect(
    withCapturedStdout(() => runFixMislinkedTransfer(FIX_ARGS, { ynab, budgetId: "budget-1" })),
  ).rejects.toThrow("Phantom still links to the surviving anchor");
  expect(calls).toHaveLength(1);
});

test("fix records completed writes when clearing the new mirror fails", async () => {
  const fixture = buildFixFixture();
  const { ynab, calls } = createYnabStub(fixture, {
    relink: "new-mirror",
    failUpdateId: MIRROR_ID,
  });
  const db = await openJournalDb(":memory:");
  try {
    const output = await withCapturedStdout(async () => {
      await expect(
        runFixMislinkedTransfer(FIX_ARGS, { ynab, budgetId: "budget-1", db }),
      ).rejects.toThrow("Update failed");
    });
    expect(JSON.parse(output)).toMatchObject([
      { action: "update-orphan-payee", status: "updated" },
      { action: "update-new-mirror-cleared", status: "failed" },
    ]);
    expect(calls.some((call) => call.method === "deleteTransaction")).toBe(false);
    const [history] = listHistoryActions(db);
    expect(history?.payload.patches).toEqual([
      { id: fixture.orphan.id, patch: { payee_id: "payee-credit" } },
    ]);
    expect(history?.inversePatch).toEqual([{ id: fixture.orphan.id, patch: { payee_id: null } }]);
  } finally {
    db.close();
  }
});

test("fix refuses cleanup if YNAB does not save the requested clearing state", async () => {
  const fixture = buildFixFixture();
  const { ynab, calls } = createYnabStub(fixture, {
    relink: "new-mirror",
    ignoreMirrorUpdate: true,
  });
  await expect(
    withCapturedStdout(() => runFixMislinkedTransfer(FIX_ARGS, { ynab, budgetId: "budget-1" })),
  ).rejects.toThrow("Counterpart clearing state was not preserved");
  expect(calls.some((call) => call.method === "deleteTransaction")).toBe(false);
});

test("fix reports incomplete cleanup if the old anchor survives detached", async () => {
  const fixture = buildFixFixture();
  const { ynab } = createYnabStub(fixture, {
    relink: "new-mirror",
    afterDelete: () =>
      fixture.transactions.set(fixture.anchor.id, {
        ...fixture.anchor,
        transfer_account_id: null,
        transfer_transaction_id: null,
      }),
  });
  await expect(
    withCapturedStdout(() => runFixMislinkedTransfer(FIX_ARGS, { ynab, budgetId: "budget-1" })),
  ).rejects.toThrow("old-pair cleanup is incomplete");
});

test("fix reports a delete failure and retains both preceding patches", async () => {
  const fixture = buildFixFixture();
  const { ynab } = createYnabStub(fixture, { relink: "new-mirror", failDelete: true });
  const db = await openJournalDb(":memory:");
  try {
    await expect(
      withCapturedStdout(() =>
        runFixMislinkedTransfer(FIX_ARGS, { ynab, budgetId: "budget-1", db }),
      ),
    ).rejects.toThrow("Delete failed");
    const [history] = listHistoryActions(db);
    expect(history?.payload.patches).toHaveLength(2);
    expect(history?.inversePatch?.find((entry) => entry.id === MIRROR_ID)?.patch).toEqual({
      cleared: "uncleared",
    });
    expect(fixture.transactions.has(fixture.phantom.id)).toBe(true);
  } finally {
    db.close();
  }
});

test("fix preview explains the conditional counterpart changes without writing", async () => {
  const fixture = buildFixFixture();
  const { ynab, calls } = createYnabStub(fixture);
  const output = await withCapturedStdout(() =>
    runFixMislinkedTransfer(
      { ...FIX_ARGS, yes: false, dryRun: true },
      { ynab, budgetId: "budget-1" },
    ),
  );
  expect(calls).toHaveLength(0);
  expect(JSON.parse(output).map((row: { action: string }) => row.action)).toEqual([
    "update-orphan-payee",
    "preserve-counterpart-cleared",
    "delete-phantom",
    "delete-old-anchor-if-replaced",
  ]);
});

const deletedTransactionCases: Array<{
  name: string;
  build: () => FixFixture;
  message: string;
}> = [
  {
    name: "anchor",
    build: () => buildFixFixture({ anchorDeleted: true }),
    message: "Anchor transaction is deleted.",
  },
  {
    name: "phantom",
    build: () => buildFixFixture({ phantomDeleted: true }),
    message: "Phantom transaction is deleted.",
  },
  {
    name: "orphan",
    build: () => buildFixFixture({ orphanDeleted: true }),
    message: "Orphan transaction is deleted.",
  },
];

for (const testCase of deletedTransactionCases) {
  test(`fix mislinked-transfer rejects deleted ${testCase.name} transaction`, async () => {
    const fixture = testCase.build();
    const { ynab, calls } = createYnabStub(fixture);

    const outcome = withCapturedStdout(() =>
      runFixMislinkedTransfer(FIX_ARGS, {
        ynab,
        budgetId: "budget-1",
      }),
    );

    await expect(outcome).rejects.toThrow(testCase.message);
    expect(calls).toHaveLength(0);
  });
}

const deletedAccountCases: Array<{
  name: string;
  build: () => FixFixture;
  message: string;
}> = [
  {
    name: "anchor",
    build: () => buildFixFixture({ anchorAccountDeleted: true }),
    message: "Anchor account is deleted.",
  },
  {
    name: "phantom",
    build: () => buildFixFixture({ phantomAccountDeleted: true }),
    message: "Phantom account is deleted.",
  },
  {
    name: "orphan",
    build: () => buildFixFixture({ orphanAccountDeleted: true }),
    message: "Orphan account is deleted.",
  },
];

for (const testCase of deletedAccountCases) {
  test(`fix mislinked-transfer rejects deleted ${testCase.name} account`, async () => {
    const fixture = testCase.build();
    const { ynab, calls } = createYnabStub(fixture);

    const outcome = withCapturedStdout(() =>
      runFixMislinkedTransfer(FIX_ARGS, {
        ynab,
        budgetId: "budget-1",
      }),
    );

    await expect(outcome).rejects.toThrow(testCase.message);
    expect(calls).toHaveLength(0);
  });
}
