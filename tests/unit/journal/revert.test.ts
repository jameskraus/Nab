import { expect, test } from "bun:test";
import type {
  Account,
  BudgetSettings,
  BudgetSummary,
  CategoryGroupWithCategories,
  NewTransaction,
  Payee,
  SaveTransactionWithIdOrImportId,
  TransactionDetail,
} from "ynab";

import type { TransactionPatch, YnabApiClient } from "@/api/YnabClient";
import { revertHistoryAction } from "@/journal/revert";
import type { HistoryAction } from "@/journal/history";

class MemoryClient implements YnabApiClient {
  private nextId = 1;
  private readonly transactions = new Map<string, TransactionDetail>();

  constructor(seed: TransactionDetail[] = []) {
    for (const tx of seed) {
      this.transactions.set(tx.id, tx);
    }
  }

  getTransactionById(id: string): TransactionDetail | undefined {
    return this.transactions.get(id);
  }

  async listBudgets(): Promise<BudgetSummary[]> {
    throw new Error("Not implemented");
  }

  async getBudgetSettings(_budgetId: string): Promise<BudgetSettings> {
    throw new Error("Not implemented");
  }

  async listAccounts(_budgetId: string): Promise<Account[]> {
    throw new Error("Not implemented");
  }

  async listCategories(_budgetId: string): Promise<CategoryGroupWithCategories[]> {
    throw new Error("Not implemented");
  }

  async listPayees(_budgetId: string): Promise<Payee[]> {
    throw new Error("Not implemented");
  }

  async listTransactions(_budgetId: string, _sinceDate?: string): Promise<TransactionDetail[]> {
    return Array.from(this.transactions.values());
  }

  async getTransaction(_budgetId: string, transactionId: string): Promise<TransactionDetail> {
    const tx = this.transactions.get(transactionId);
    if (!tx) throw new Error(`Missing transaction ${transactionId}`);
    return tx;
  }

  async createTransaction(
    _budgetId: string,
    transaction: NewTransaction,
  ): Promise<TransactionDetail> {
    const id = `new-${this.nextId++}`;
    const detail = buildTransaction({
      id,
      account_id: transaction.account_id,
      date: transaction.date,
      amount: transaction.amount,
      memo: transaction.memo ?? null,
      payee_id: transaction.payee_id ?? null,
      category_id: transaction.category_id ?? null,
      cleared: transaction.cleared ?? "uncleared",
      approved: transaction.approved ?? false,
      flag_color: transaction.flag_color ?? null,
      import_id: transaction.import_id ?? null,
    });
    this.transactions.set(id, detail);
    return detail;
  }

  async updateTransaction(
    _budgetId: string,
    transactionId: string,
    patch: TransactionPatch,
  ): Promise<TransactionDetail> {
    const current = this.transactions.get(transactionId);
    if (!current) throw new Error(`Missing transaction ${transactionId}`);
    const updated = { ...current, ...patch } as TransactionDetail;
    this.transactions.set(transactionId, updated);
    return updated;
  }

  async updateTransactions(
    _budgetId: string,
    transactions: SaveTransactionWithIdOrImportId[],
  ): Promise<TransactionDetail[]> {
    const updated: TransactionDetail[] = [];
    for (const tx of transactions) {
      const patch = { ...tx } as Partial<TransactionDetail> & { id?: string };
      if (!patch.id) continue;
      updated.push(await this.updateTransaction(_budgetId, patch.id, patch));
    }
    return updated;
  }

  async deleteTransaction(_budgetId: string, transactionId: string): Promise<TransactionDetail> {
    const current = this.transactions.get(transactionId);
    if (!current) throw new Error(`Missing transaction ${transactionId}`);
    this.transactions.delete(transactionId);
    return current;
  }
}

function buildTransaction(overrides: Partial<TransactionDetail>): TransactionDetail {
  return {
    id: overrides.id ?? "tx-1",
    account_id: overrides.account_id ?? "acc-1",
    date: overrides.date ?? "2026-01-01",
    amount: overrides.amount ?? -1000,
    memo: overrides.memo ?? null,
    payee_id: overrides.payee_id ?? null,
    category_id: overrides.category_id ?? null,
    cleared: overrides.cleared ?? "uncleared",
    approved: overrides.approved ?? true,
    flag_color: overrides.flag_color ?? null,
    import_id: overrides.import_id ?? null,
    transfer_account_id: overrides.transfer_account_id ?? null,
    transfer_transaction_id: overrides.transfer_transaction_id ?? null,
    account_name: "Account",
    payee_name: null,
    category_name: null,
    deleted: false,
    subtransactions: [],
  } as TransactionDetail;
}

test("revertHistoryAction applies inverse patch and records forward patch", async () => {
  const client = new MemoryClient([
    buildTransaction({ id: "t1", memo: "new" }),
  ]);

  const history: HistoryAction = {
    id: "h1",
    createdAt: "2026-01-01T00:00:00Z",
    actionType: "tx.memo.set",
    payload: {
      argv: {},
      txIds: ["t1"],
      patches: [{ id: "t1", patch: { memo: "new" } }],
    },
    inversePatch: [{ id: "t1", patch: { memo: null } }],
  };

  const outcome = await revertHistoryAction({
    ynab: client,
    budgetId: "budget",
    history,
  });

  const updated = client.getTransactionById("t1");
  expect(updated?.memo ?? null).toBe(null);
  expect(outcome.results[0]?.status).toBe("updated");
  expect(outcome.appliedPatches).toEqual([{ id: "t1", patch: { memo: null } }]);
  expect(outcome.inversePatches).toEqual([{ id: "t1", patch: { memo: "new" } }]);
});

test("revertHistoryAction restores deleted transaction", async () => {
  const client = new MemoryClient();
  const deleted = buildTransaction({ id: "t42", memo: "deleted" });

  const history: HistoryAction = {
    id: "h2",
    createdAt: "2026-01-01T00:00:00Z",
    actionType: "tx.delete",
    payload: {
      argv: {},
      txIds: ["t42"],
      patches: [{ id: "t42", patch: { delete: true } }],
    },
    inversePatch: [{ id: "t42", patch: { restore: deleted } }],
  };

  const outcome = await revertHistoryAction({
    ynab: client,
    budgetId: "budget",
    history,
  });

  const result = outcome.results[0];
  expect(result?.status).toBe("updated");
  expect(result?.restoredId).toBe("new-1");
  expect(outcome.inversePatches).toEqual([{ id: "new-1", patch: { delete: true } }]);
  expect(client.getTransactionById("new-1")?.memo).toBe("deleted");
});
