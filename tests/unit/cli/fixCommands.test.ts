import { afterAll, expect, test } from "bun:test";
import type { Account, TransactionDetail } from "ynab";

import { type FixMislinkedTransferContext, runFixMislinkedTransfer } from "@/cli/commands/fix";
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

type YnabCall =
  | { method: "updateTransaction"; id: string; patch: { payee_id?: string } }
  | { method: "deleteTransaction"; id: string };

const FIX_ARGS = {
  anchor: "anchor-id",
  phantom: "phantom-id",
  orphan: "orphan-id",
  yes: true,
  format: "json",
};

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
}: {
  anchorCleared?: ClearedStatus;
  phantomCleared?: ClearedStatus;
  orphanCleared?: ClearedStatus;
} = {}): FixFixture {
  const anchorAccount = acc({
    id: "acc-credit",
    name: "Credit",
    type: "creditCard",
    transfer_payee_id: "payee-credit",
  });
  const phantomAccount = acc({
    id: "acc-phantom",
    name: "Phantom Checking",
    type: "checking",
    transfer_payee_id: "payee-phantom",
  });
  const orphanAccount = acc({
    id: "acc-orphan",
    name: "Orphan Checking",
    type: "checking",
    transfer_payee_id: "payee-orphan",
  });

  const { anchor, phantom } = linkedTransferPair({
    anchor: {
      id: FIX_ARGS.anchor,
      account_name: anchorAccount.name,
      amount: 100000,
      cleared: anchorCleared,
      import_id: "YNAB:100000:2026-01-22:1",
    },
    phantom: {
      id: FIX_ARGS.phantom,
      account_name: phantomAccount.name,
      amount: -100000,
      cleared: phantomCleared,
      import_id: null,
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
  options: { unlinkPhantomAfterUpdate?: boolean } = {},
): { ynab: FixMislinkedTransferContext["ynab"]; calls: YnabCall[] } {
  const calls: YnabCall[] = [];
  const unlinkPhantomAfterUpdate = options.unlinkPhantomAfterUpdate ?? true;

  const ynab = {
    getTransaction: async (_budgetId: string, id: string) => {
      const tx = fixture.transactions.get(id);
      if (!tx) throw new Error(`Missing transaction: ${id}`);
      return tx;
    },
    listAccounts: async () => fixture.accounts,
    updateTransaction: async (_budgetId: string, id: string, patch: { payee_id?: string }) => {
      calls.push({ method: "updateTransaction", id, patch });
      const current = fixture.transactions.get(id);
      if (!current) throw new Error(`Missing transaction: ${id}`);
      const updated = { ...current, ...patch };

      if (id === fixture.orphan.id && unlinkPhantomAfterUpdate) {
        const phantom = fixture.transactions.get(fixture.phantom.id);
        if (phantom) {
          fixture.transactions.set(fixture.phantom.id, {
            ...phantom,
            transfer_transaction_id: null,
          });
        }
      }

      fixture.transactions.set(id, updated);
      return updated;
    },
    deleteTransaction: async (_budgetId: string, id: string) => {
      calls.push({ method: "deleteTransaction", id });
      const current = fixture.transactions.get(id);
      if (!current) throw new Error(`Missing transaction: ${id}`);
      return current;
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
    const { ynab, calls } = createYnabStub(fixture, { unlinkPhantomAfterUpdate: true });

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
  const { ynab, calls } = createYnabStub(fixture, { unlinkPhantomAfterUpdate: false });

  const outcome = withCapturedStdout(() =>
    runFixMislinkedTransfer(FIX_ARGS, {
      ynab,
      budgetId: "budget-1",
    }),
  );

  await expect(outcome).rejects.toThrow("Phantom is still linked to anchor after relink attempt.");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.method).toBe("updateTransaction");
  expect(calls[0]?.id).toBe(fixture.orphan.id);
  expect(calls.some((call) => call.method === "deleteTransaction")).toBe(false);
});
