import type { TransactionDetail } from "ynab";

import type { YnabClient } from "@/api/YnabClient";

type CleanupOptions = {
  memoPrefix?: string;
};

function isTestTransaction(
  transaction: TransactionDetail,
  memoPrefix: string,
): transaction is TransactionDetail & { memo: string } {
  return Boolean(transaction.memo?.startsWith(memoPrefix));
}

export async function cleanupTestTransactions(
  client: YnabClient,
  budgetId: string,
  options: CleanupOptions = {},
): Promise<{ deleted: number; ids: string[] }> {
  const memoPrefix = options.memoPrefix ?? "__nab_";
  const transactions = await client.listTransactions(budgetId);
  const targets = transactions.filter((transaction) => isTestTransaction(transaction, memoPrefix));

  for (const transaction of targets) {
    await client.deleteTransaction(budgetId, transaction.id);
  }

  return { deleted: targets.length, ids: targets.map((transaction) => transaction.id) };
}
