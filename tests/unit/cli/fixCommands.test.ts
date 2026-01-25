import { expect, test } from "bun:test";
import type { Account, TransactionDetail } from "ynab";

import { runFixMislinkedTransfer } from "@/cli/commands/fix";

function makeTransaction(overrides: Partial<TransactionDetail>): TransactionDetail {
  return {
    id: "tx-1",
    date: "2026-01-22",
    amount: -5000,
    cleared: "cleared",
    approved: false,
    account_id: "acc-1",
    deleted: false,
    account_name: "Checking",
    subtransactions: [],
    ...overrides,
  };
}

function makeAccount(overrides: Partial<Account>): Account {
  return {
    id: "acc-1",
    name: "Account",
    type: "checking",
    on_budget: true,
    closed: false,
    transfer_payee_id: "payee-1",
    direct_import_linked: true,
    direct_import_in_error: false,
    deleted: false,
    balance: 0,
    cleared_balance: 0,
    uncleared_balance: 0,
    ...overrides,
  };
}

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

test("fix mislinked-transfer updates orphan payee then deletes phantom", async () => {
  const anchor = makeTransaction({
    id: "anchor-id",
    account_id: "acc-credit",
    account_name: "Credit",
    amount: 100000,
    cleared: "cleared",
    import_id: "YNAB:100000:2026-01-22:1",
    transfer_account_id: "acc-phantom",
    transfer_transaction_id: "phantom-id",
  });
  const phantom = makeTransaction({
    id: "phantom-id",
    account_id: "acc-phantom",
    account_name: "Checking",
    amount: -100000,
    cleared: "uncleared",
    transfer_account_id: "acc-credit",
    transfer_transaction_id: "anchor-id",
  });
  const orphan = makeTransaction({
    id: "orphan-id",
    account_id: "acc-orphan",
    account_name: "Checking 2",
    amount: -100000,
    cleared: "cleared",
    import_id: "YNAB:-100000:2026-01-22:1",
    transfer_account_id: null,
    transfer_transaction_id: null,
  });

  const accounts: Account[] = [
    makeAccount({
      id: "acc-credit",
      name: "Credit",
      type: "creditCard",
      transfer_payee_id: "payee-credit",
    }),
    makeAccount({
      id: "acc-phantom",
      name: "Phantom Checking",
      type: "checking",
      transfer_payee_id: "payee-phantom",
    }),
    makeAccount({
      id: "acc-orphan",
      name: "Orphan Checking",
      type: "checking",
      transfer_payee_id: "payee-orphan",
    }),
  ];

  const transactions = new Map([
    [anchor.id, anchor],
    [phantom.id, phantom],
    [orphan.id, orphan],
  ]);

  const calls: Array<{ method: string; args: unknown[] }> = [];
  const ynab = {
    getTransaction: async (_budgetId: string, id: string) => {
      const tx = transactions.get(id);
      if (!tx) throw new Error(`Missing transaction: ${id}`);
      return tx;
    },
    listAccounts: async () => accounts,
    updateTransaction: async (_budgetId: string, id: string, patch: { payee_id?: string }) => {
      calls.push({ method: "updateTransaction", args: [_budgetId, id, patch] });
      const current = transactions.get(id) ?? orphan;
      return { ...current, ...patch };
    },
    deleteTransaction: async (_budgetId: string, id: string) => {
      calls.push({ method: "deleteTransaction", args: [_budgetId, id] });
      const current = transactions.get(id) ?? phantom;
      return current;
    },
  };

  await withCapturedStdout(() =>
    runFixMislinkedTransfer(
      {
        anchor: "anchor-id",
        phantom: "phantom-id",
        orphan: "orphan-id",
        yes: true,
        format: "json",
      },
      { ynab, budgetId: "budget-1" },
    ),
  );

  expect(calls).toHaveLength(2);
  expect(calls[0]?.method).toBe("updateTransaction");
  expect(calls[0]?.args[1]).toBe("orphan-id");
  expect((calls[0]?.args[2] as { payee_id?: string }).payee_id).toBe("payee-credit");
  expect(calls[1]?.method).toBe("deleteTransaction");
  expect(calls[1]?.args[1]).toBe("phantom-id");
  expect(
    calls.some((call) => call.method === "updateTransaction" && call.args[1] === "anchor-id"),
  ).toBe(false);
});
