import type { TransactionDetail } from "ynab";

export type TransactionReviewIssue = "unapproved" | "uncategorized";
export type TransactionReviewKind = "regular" | "split" | "transfer";
export type TransactionReviewSplitLimitation = "split_editing_not_supported";

export type TransactionReviewItem = {
  id: string;
  date: string;
  account_id: string;
  account_name: string;
  payee_id: string | null;
  payee_name: string | null;
  import_payee_name: string | null;
  import_payee_name_original: string | null;
  category_id: string | null;
  category_name: string | null;
  memo: string | null;
  import_id: string | null;
  amount_milliunits: number;
  approved: boolean;
  cleared: TransactionDetail["cleared"];
  kind: TransactionReviewKind;
  issues: TransactionReviewIssue[];
  transfer_account_id: string | null;
  transfer_transaction_id: string | null;
  split_subtransaction_count: number;
  split_uncategorized_subtransaction_count: number;
  split_limitation: TransactionReviewSplitLimitation | null;
};

export type TransactionReviewCounts = {
  total: number;
  returned: number;
  unapproved: number;
  uncategorized: number;
  both: number;
};

export type TransactionReview = {
  items: TransactionReviewItem[];
  counts: TransactionReviewCounts;
  truncated: boolean;
};

export type BuildTransactionReviewInput = {
  unapprovedTransactions: readonly TransactionDetail[];
  uncategorizedTransactions: readonly TransactionDetail[];
  accountNamePrefixes?: readonly string[];
  limit?: number;
};

type TransactionWithIssues = {
  transaction: TransactionDetail;
  issues: Set<TransactionReviewIssue>;
};

function activeSubtransactions(transaction: TransactionDetail) {
  if (!Array.isArray(transaction.subtransactions)) return [];
  return transaction.subtransactions.filter((subtransaction) => !subtransaction.deleted);
}

function isSubtransactionTransfer(
  subtransaction: TransactionDetail["subtransactions"][number],
): boolean {
  return Boolean(subtransaction.transfer_account_id || subtransaction.transfer_transaction_id);
}

function isSubtransactionUncategorized(
  subtransaction: TransactionDetail["subtransactions"][number],
): boolean {
  if (isSubtransactionTransfer(subtransaction)) return false;
  return (
    subtransaction.category_id === null ||
    subtransaction.category_id === undefined ||
    subtransaction.category_name === "Uncategorized"
  );
}

export function isTransferTransaction(transaction: TransactionDetail): boolean {
  return Boolean(transaction.transfer_account_id || transaction.transfer_transaction_id);
}

export function transactionReviewKind(transaction: TransactionDetail): TransactionReviewKind {
  if (isTransferTransaction(transaction)) return "transfer";
  if (activeSubtransactions(transaction).length > 0) return "split";
  return "regular";
}

export function isActionableUncategorizedTransaction(transaction: TransactionDetail): boolean {
  if (transaction.deleted || isTransferTransaction(transaction)) return false;

  const subtransactions = activeSubtransactions(transaction);
  if (subtransactions.length > 0) {
    return subtransactions.some(isSubtransactionUncategorized);
  }

  return (
    transaction.category_id === null ||
    transaction.category_id === undefined ||
    transaction.category_name === "Uncategorized"
  );
}

export function isUnapprovedTransaction(transaction: TransactionDetail): boolean {
  return !transaction.deleted && transaction.approved === false;
}

function matchesAccountNamePrefix(
  transaction: TransactionDetail,
  accountNamePrefixes: readonly string[] | undefined,
): boolean {
  if (!accountNamePrefixes || accountNamePrefixes.length === 0) return true;
  return accountNamePrefixes.some((prefix) => transaction.account_name.startsWith(prefix));
}

function addIssue(
  transactionsById: Map<string, TransactionWithIssues>,
  transaction: TransactionDetail,
  issue: TransactionReviewIssue,
): void {
  const existing = transactionsById.get(transaction.id);
  if (existing) {
    existing.issues.add(issue);
    return;
  }

  transactionsById.set(transaction.id, {
    transaction,
    issues: new Set([issue]),
  });
}

function issuePriority(issues: Set<TransactionReviewIssue>): number {
  if (issues.has("unapproved") && !issues.has("uncategorized")) return 0;
  return 1;
}

function kindPriority(kind: TransactionReviewKind): number {
  if (kind === "regular") return 0;
  if (kind === "split") return 2;
  return 3;
}

function reviewPriority(item: TransactionWithIssues): number {
  const kind = transactionReviewKind(item.transaction);
  if (kind !== "regular") return kindPriority(kind);
  return issuePriority(item.issues);
}

function compareTransactions(left: TransactionWithIssues, right: TransactionWithIssues): number {
  const priorityDifference = reviewPriority(left) - reviewPriority(right);
  if (priorityDifference !== 0) return priorityDifference;

  return (
    left.transaction.date.localeCompare(right.transaction.date) ||
    left.transaction.account_name.localeCompare(right.transaction.account_name) ||
    (left.transaction.payee_name ?? "").localeCompare(right.transaction.payee_name ?? "") ||
    left.transaction.id.localeCompare(right.transaction.id)
  );
}

function toReviewItem(item: TransactionWithIssues): TransactionReviewItem {
  const { transaction } = item;
  const kind = transactionReviewKind(transaction);
  const subtransactions = activeSubtransactions(transaction);

  return {
    id: transaction.id,
    date: transaction.date,
    account_id: transaction.account_id,
    account_name: transaction.account_name,
    payee_id: transaction.payee_id ?? null,
    payee_name: transaction.payee_name ?? null,
    import_payee_name: transaction.import_payee_name ?? null,
    import_payee_name_original: transaction.import_payee_name_original ?? null,
    category_id: transaction.category_id ?? null,
    category_name: transaction.category_name ?? null,
    memo: transaction.memo ?? null,
    import_id: transaction.import_id ?? null,
    amount_milliunits: transaction.amount,
    approved: transaction.approved,
    cleared: transaction.cleared,
    kind,
    issues: (["unapproved", "uncategorized"] as const).filter((issue) => item.issues.has(issue)),
    transfer_account_id: transaction.transfer_account_id ?? null,
    transfer_transaction_id: transaction.transfer_transaction_id ?? null,
    split_subtransaction_count: kind === "split" ? subtransactions.length : 0,
    split_uncategorized_subtransaction_count:
      kind === "split" ? subtransactions.filter(isSubtransactionUncategorized).length : 0,
    split_limitation: kind === "split" ? "split_editing_not_supported" : null,
  };
}

function validateLimit(limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("Transaction review limit must be a non-negative integer");
  }
}

export function buildTransactionReview({
  unapprovedTransactions,
  uncategorizedTransactions,
  accountNamePrefixes,
  limit,
}: BuildTransactionReviewInput): TransactionReview {
  validateLimit(limit);

  const transactionsById = new Map<string, TransactionWithIssues>();

  for (const transaction of unapprovedTransactions) {
    if (!isUnapprovedTransaction(transaction)) continue;
    if (!matchesAccountNamePrefix(transaction, accountNamePrefixes)) continue;
    addIssue(transactionsById, transaction, "unapproved");
  }

  for (const transaction of uncategorizedTransactions) {
    if (!isActionableUncategorizedTransaction(transaction)) continue;
    if (!matchesAccountNamePrefix(transaction, accountNamePrefixes)) continue;
    addIssue(transactionsById, transaction, "uncategorized");
  }

  const matches = [...transactionsById.values()].sort(compareTransactions);
  const unapproved = matches.filter((item) => item.issues.has("unapproved")).length;
  const uncategorized = matches.filter((item) => item.issues.has("uncategorized")).length;
  const both = matches.filter(
    (item) => item.issues.has("unapproved") && item.issues.has("uncategorized"),
  ).length;
  const selected = limit === undefined ? matches : matches.slice(0, limit);

  return {
    items: selected.map(toReviewItem),
    counts: {
      total: matches.length,
      returned: selected.length,
      unapproved,
      uncategorized,
      both,
    },
    truncated: selected.length < matches.length,
  };
}
