import { expect, test } from "bun:test";
import type {
  Account,
  BudgetSettings,
  BudgetSummary,
  Category,
  CategoryGroupWithCategories,
  MonthDetail,
  MonthSummary,
  NewTransaction,
  Payee,
  SaveTransactionWithIdOrImportId,
  TransactionDetail,
} from "ynab";

import type { TransactionListType, TransactionPatch, YnabApiClient } from "@/api/YnabClient";
import type { HistoryAction } from "@/journal/history";
import { revertHistoryAction } from "@/journal/revert";

class MemoryClient implements YnabApiClient {
  private nextId = 1;
  private readonly transactions = new Map<string, TransactionDetail>();

  constructor(
    seed: TransactionDetail[] = [],
    private readonly budgetMonth?: MonthDetail,
  ) {
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

  async getBudgetMonth(): Promise<MonthDetail> {
    if (!this.budgetMonth) throw new Error("Not implemented");
    return structuredClone(this.budgetMonth);
  }

  async listBudgetMonths(): Promise<MonthSummary[]> {
    if (!this.budgetMonth) throw new Error("Not implemented");
    const { categories: _categories, ...summary } = this.budgetMonth;
    return [structuredClone(summary)];
  }

  async getMonthCategory(_budgetId: string, _month: string, categoryId: string): Promise<Category> {
    const category = this.budgetMonth?.categories.find((candidate) => candidate.id === categoryId);
    if (!category) throw new Error("Not implemented");
    return structuredClone(category);
  }

  async updateMonthCategory(
    _budgetId: string,
    _month: string,
    categoryId: string,
    budgetedMilliunits: number,
  ): Promise<Category> {
    const category = this.budgetMonth?.categories.find((candidate) => candidate.id === categoryId);
    if (!category || !this.budgetMonth) throw new Error("Not implemented");
    const delta = budgetedMilliunits - category.budgeted;
    category.budgeted = budgetedMilliunits;
    this.budgetMonth.budgeted += delta;
    this.budgetMonth.to_be_budgeted -= delta;
    return structuredClone(category);
  }

  async listPayees(_budgetId: string): Promise<Payee[]> {
    throw new Error("Not implemented");
  }

  async listTransactions(
    _budgetId: string,
    _sinceDate?: string,
    _type?: TransactionListType,
  ): Promise<TransactionDetail[]> {
    return Array.from(this.transactions.values());
  }

  async listAccountTransactions(
    _budgetId: string,
    accountId: string,
    _sinceDate?: string,
    _type?: TransactionListType,
  ): Promise<TransactionDetail[]> {
    return Array.from(this.transactions.values()).filter((tx) => tx.account_id === accountId);
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
  const client = new MemoryClient([buildTransaction({ id: "t1", memo: "new" })]);

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

test("revertHistoryAction restores a month-category assigned amount", async () => {
  const category = {
    id: "category-1",
    category_group_id: "group-1",
    name: "Rent",
    hidden: false,
    budgeted: 200_000,
    activity: 0,
    balance: 200_000,
    deleted: false,
  } as Category;
  const month = {
    month: "2026-07-01",
    income: 1_000_000,
    budgeted: 900_000,
    activity: 0,
    to_be_budgeted: 100_000,
    deleted: false,
    categories: [category],
  } as MonthDetail;
  const client = new MemoryClient([], month);
  const history: HistoryAction = {
    id: "h-category",
    createdAt: "2026-07-01T00:00:00Z",
    actionType: "category.assigned.set",
    payload: {
      argv: {},
      targets: [
        {
          resource: "month_category",
          id: "category-1",
          month: "2026-07-01",
        },
      ],
      patches: [
        {
          resource: "month_category",
          id: "category-1",
          month: "2026-07-01",
          patch: { budgeted: 200_000 },
        },
      ],
    },
    inversePatch: [
      {
        resource: "month_category",
        id: "category-1",
        month: "2026-07-01",
        patch: { budgeted: 100_000 },
      },
    ],
  };

  const outcome = await revertHistoryAction({
    ynab: client,
    budgetId: "budget",
    history,
  });

  expect((await client.getMonthCategory("budget", "2026-07-01", "category-1")).budgeted).toBe(
    100_000,
  );
  expect(outcome.results[0]).toMatchObject({
    id: "category-1",
    status: "updated",
    patch: { budgeted: 100_000 },
    resource: "month_category",
    month: "2026-07-01",
    categoryAssignment: {
      readyToAssignGuardMonth: "2026-07-01",
      readyToAssignProjectedMilliunits: 200_000,
      wouldOverAssign: false,
    },
  });
  expect(outcome.inversePatches).toEqual([
    {
      id: "category-1",
      resource: "month_category",
      month: "2026-07-01",
      patch: { budgeted: 200_000 },
    },
  ]);
});

test("month-category revert dry-run exposes a future Ready to Assign warning", async () => {
  const category = {
    id: "category-1",
    category_group_id: "group-1",
    name: "Rent",
    hidden: false,
    budgeted: 100_000,
    activity: 0,
    balance: 100_000,
    deleted: false,
  } as Category;
  const month = {
    month: "2026-07-01",
    income: 1_000_000,
    budgeted: 950_000,
    activity: 0,
    to_be_budgeted: 50_000,
    deleted: false,
    categories: [category],
  } as MonthDetail;
  const history: HistoryAction = {
    id: "h-category-preview",
    createdAt: "2026-07-01T00:00:00Z",
    actionType: "category.assigned.set",
    payload: {
      argv: {},
      targets: [{ resource: "month_category", id: "category-1", month: "2026-07-01" }],
      patches: [
        {
          resource: "month_category",
          id: "category-1",
          month: "2026-07-01",
          patch: { budgeted: 100_000 },
        },
      ],
    },
    inversePatch: [
      {
        resource: "month_category",
        id: "category-1",
        month: "2026-07-01",
        patch: { budgeted: 200_000 },
      },
    ],
  };

  const outcome = await revertHistoryAction({
    ynab: new MemoryClient([], month),
    budgetId: "budget",
    history,
    dryRun: true,
  });

  expect(outcome.results[0]).toMatchObject({
    status: "dry-run",
    categoryAssignment: {
      readyToAssignGuardMonth: "2026-07-01",
      readyToAssignProjectedMilliunits: -50_000,
      wouldOverAssign: true,
      verified: false,
    },
  });
  expect(outcome.appliedPatches).toEqual([]);
});
