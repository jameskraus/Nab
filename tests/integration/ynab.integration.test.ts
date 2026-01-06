import { expect, test } from "bun:test";
import type {
  Account,
  CategoryGroupWithCategories,
  NewTransaction,
  Payee,
  TransactionDetail,
} from "ynab";

import { YnabClient } from "@/api/YnabClient";
import { TransactionService } from "@/domain/TransactionService";

const REQUIRED_BUDGET_ID = "06443689-ec9d-45d9-a37a-53dc60014769";

const tokens = process.env.NAB_TOKENS
  ? process.env.NAB_TOKENS.split(",")
      .map((token) => token.trim())
      .filter(Boolean)
  : [];
const token = tokens[0];
const budgetId = process.env.NAB_BUDGET_ID;

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function pickAccount(accounts: Account[]): Account | null {
  return (
    accounts.find((account) => !account.closed && account.on_budget) ??
    accounts.find((account) => !account.closed) ??
    accounts[0] ??
    null
  );
}

function pickAlternateAccount(accounts: Account[], primaryId: string): Account | null {
  return (
    accounts.find((account) => account.id !== primaryId && !account.closed && account.on_budget) ??
    accounts.find((account) => account.id !== primaryId && !account.closed) ??
    null
  );
}

function pickCategory(groups: CategoryGroupWithCategories[]): { id: string } | null {
  for (const group of groups) {
    if (group.name === "Credit Card Payments") continue;
    for (const category of group.categories) {
      if (category.deleted || category.hidden) continue;
      return { id: category.id };
    }
  }
  return null;
}

function pickPayee(payees: Payee[]): Payee | null {
  return payees.find((payee) => !payee.deleted && !payee.transfer_account_id) ?? null;
}

async function createTestTransaction(
  client: YnabClient,
  budgetId: string,
  accountId: string,
  overrides: Partial<NewTransaction> = {},
): Promise<TransactionDetail> {
  const base: NewTransaction = {
    account_id: accountId,
    date: formatDate(new Date()),
    amount: -1200,
    memo: "__nab_integration_test__",
    approved: true,
  };
  return client.createTransaction(budgetId, { ...base, ...overrides });
}

function pickWritableTransaction(transactions: TransactionDetail[]): TransactionDetail | null {
  const candidate = transactions.find((transaction) => {
    const hasSplits =
      Array.isArray(transaction.subtransactions) && transaction.subtransactions.length > 0;
    return !transaction.transfer_account_id && !transaction.transfer_transaction_id && !hasSplits;
  });
  return candidate ?? null;
}

function pickTransferTransaction(transactions: TransactionDetail[]): TransactionDetail | null {
  const candidate = transactions.find(
    (transaction) =>
      Boolean(transaction.transfer_account_id || transaction.transfer_transaction_id) &&
      !transaction.deleted,
  );
  return candidate ?? null;
}

if (!token || !budgetId) {
  test.skip("integration: set NAB_TOKENS and NAB_BUDGET_ID to run", () => {});
} else if (budgetId !== REQUIRED_BUDGET_ID) {
  test("integration: budget id must be the dedicated test budget", () => {
    throw new Error(
      `NAB_BUDGET_ID must be ${REQUIRED_BUDGET_ID} (got ${budgetId}). Refuse to run.`,
    );
  });
} else {
  const client = new YnabClient(tokens);

  test("integration: list budgets includes test budget", async () => {
    const budgets = await client.listBudgets();
    expect(Array.isArray(budgets)).toBe(true);
    expect(budgets.some((budget) => budget.id === REQUIRED_BUDGET_ID)).toBe(true);
  });

  test("integration: list accounts returns accounts", async () => {
    const accounts = await client.listAccounts(budgetId);
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts.length).toBeGreaterThan(0);
  });

  test("integration: list categories returns groups", async () => {
    const groups = await client.listCategories(budgetId);
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThan(0);
  });

  test("integration: list payees returns payees", async () => {
    const payees = await client.listPayees(budgetId);
    expect(Array.isArray(payees)).toBe(true);
    expect(payees.length).toBeGreaterThan(0);
  });

  test("integration: list and get transactions", async () => {
    const transactions = await client.listTransactions(budgetId);
    expect(Array.isArray(transactions)).toBe(true);
    if (transactions.length === 0) return;

    const transaction = await client.getTransaction(budgetId, transactions[0].id);
    expect(transaction.id).toBe(transactions[0].id);
  });

  test("integration: approve dry-run does not apply", async () => {
    const transactions = await client.listTransactions(budgetId);
    if (transactions.length === 0) return;

    const service = new TransactionService(client, budgetId);
    const results = await service.setApproved([transactions[0].id], true, { dryRun: true });
    expect(results[0]?.status).not.toBe("updated");
  });

  test("integration: memo mutation applies and reverts", async () => {
    const transactions = await client.listTransactions(budgetId);
    const target = pickWritableTransaction(transactions);
    if (!target) return;

    const service = new TransactionService(client, budgetId);
    const current = await client.getTransaction(budgetId, target.id);
    const originalMemo = current.memo ?? null;
    const testMemo =
      originalMemo === "__nab_integration_test__"
        ? "__nab_integration_test__2"
        : "__nab_integration_test__";

    try {
      const results = await service.applyPatch([current.id], { memo: testMemo }, { dryRun: false });
      expect(results[0]?.status).toBe("updated");

      const updated = await client.getTransaction(budgetId, current.id);
      expect(updated.memo ?? null).toBe(testMemo);
    } finally {
      await service.applyPatch([current.id], { memo: originalMemo }, { dryRun: false });
    }

    const restored = await client.getTransaction(budgetId, current.id);
    expect(restored.memo ?? null).toBe(originalMemo);
  });

  test("integration: tx mutation commands apply and verify", async () => {
    const accounts = await client.listAccounts(budgetId);
    const account = pickAccount(accounts);
    if (!account) return;

    const altAccount = pickAlternateAccount(accounts, account.id);
    const categories = await client.listCategories(budgetId);
    const category = pickCategory(categories);
    const payees = await client.listPayees(budgetId);
    const payee = pickPayee(payees);

    const transaction = await createTestTransaction(client, budgetId, account.id);
    const service = new TransactionService(client, budgetId);
    const yesterday = formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));

    try {
      await service.setApproved([transaction.id], false);
      let current = await client.getTransaction(budgetId, transaction.id);
      expect(current.approved).toBe(false);

      await service.setApproved([transaction.id], true);
      current = await client.getTransaction(budgetId, transaction.id);
      expect(current.approved).toBe(true);

      if (category) {
        await service.applyPatch([transaction.id], { category_id: category.id });
        current = await client.getTransaction(budgetId, transaction.id);
        expect(current.category_id).toBe(category.id);

        await service.applyPatch([transaction.id], { category_id: null });
        current = await client.getTransaction(budgetId, transaction.id);
        expect(current.category_id ?? null).toBe(null);
      }

      await service.applyPatch([transaction.id], { flag_color: "red" });
      current = await client.getTransaction(budgetId, transaction.id);
      expect(current.flag_color).toBe("red");

      await service.applyPatch([transaction.id], { flag_color: null });
      current = await client.getTransaction(budgetId, transaction.id);
      expect(current.flag_color ?? null).toBe(null);

      await service.applyPatch([transaction.id], { cleared: "cleared" });
      current = await client.getTransaction(budgetId, transaction.id);
      expect(current.cleared).toBe("cleared");

      await service.applyPatch([transaction.id], { date: yesterday });
      current = await client.getTransaction(budgetId, transaction.id);
      expect(current.date).toBe(yesterday);

      if (payee) {
        await service.applyPatch([transaction.id], { payee_id: payee.id });
        current = await client.getTransaction(budgetId, transaction.id);
        expect(current.payee_id).toBe(payee.id);
      }

      await service.applyPatch([transaction.id], { amount: -2500 });
      current = await client.getTransaction(budgetId, transaction.id);
      expect(current.amount).toBe(-2500);

      if (altAccount) {
        await service.applyPatch([transaction.id], { account_id: altAccount.id });
        current = await client.getTransaction(budgetId, transaction.id);
        expect(current.account_id).toBe(altAccount.id);
      }
    } finally {
      await client.deleteTransaction(budgetId, transaction.id);
    }
  });

  test("integration: delete removes transaction", async () => {
    const accounts = await client.listAccounts(budgetId);
    const account = pickAccount(accounts);
    if (!account) return;

    const transaction = await createTestTransaction(client, budgetId, account.id, {
      memo: "__nab_integration_delete__",
    });
    const service = new TransactionService(client, budgetId);

    await service.deleteTransactions([transaction.id], { dryRun: false });

    await expect(client.getTransaction(budgetId, transaction.id)).rejects.toBeTruthy();
  });

  test("integration: account set rejects transfers", async () => {
    const transactions = await client.listTransactions(budgetId);
    const transfer = pickTransferTransaction(transactions);
    if (!transfer) return;

    const accounts = await client.listAccounts(budgetId);
    const account = pickAccount(accounts);
    if (!account) return;

    const service = new TransactionService(client, budgetId);
    await expect(
      service.mutateTransactions([transfer.id], () => ({ account_id: account.id }), {
        dryRun: true,
      }),
    ).rejects.toThrow("Transfers cannot be moved in v1.");
  });
}
