import type { Account, TransactionDetail } from "ynab";

type OrphanCandidate = TransactionDetail;

type MislinkedTransferMatch = {
  anchor: TransactionDetail;
  phantom: TransactionDetail;
  orphan_candidates: OrphanCandidate[];
};

type MislinkedTransferOptions = {
  importLagDays: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function toDateMs(value: string): number | null {
  const parts = value.split("-");
  if (parts.length !== 3) return null;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const ms = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

function withinDayDelta(a: string, b: string, maxDays: number): boolean {
  const aMs = toDateMs(a);
  const bMs = toDateMs(b);
  if (aMs === null || bMs === null) return false;
  return Math.abs(aMs - bMs) / DAY_MS <= maxDays;
}

function isCheckingOrSavings(account: Account | undefined): boolean {
  return Boolean(
    account &&
      (account.type === "checking" || account.type === "savings") &&
      account.on_budget &&
      !account.closed,
  );
}

function isCredit(account: Account | undefined): boolean {
  return Boolean(account && account.type === "creditCard" && account.on_budget && !account.closed);
}

function isDirectImportActive(account: Account | undefined): boolean {
  return Boolean(
    account?.direct_import_linked === true && account?.direct_import_in_error !== true,
  );
}

function orphanIndexKey(kind: "cash" | "credit", amount: number): string {
  return `${kind}:${amount}`;
}

export function findMislinkedTransfers(
  accounts: Account[],
  transactions: TransactionDetail[],
  options: MislinkedTransferOptions,
): MislinkedTransferMatch[] {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const transactionsById = new Map(
    transactions.map((transaction) => [transaction.id, transaction]),
  );

  const orphanIndex = new Map<string, TransactionDetail[]>();

  for (const transaction of transactions) {
    if (transaction.transfer_account_id) continue;
    if (!transaction.import_id) continue;
    if (transaction.cleared !== "cleared") continue;

    const account = accountById.get(transaction.account_id);
    if (!account) continue;
    if (!isDirectImportActive(account)) continue;

    const kind = isCheckingOrSavings(account) ? "cash" : isCredit(account) ? "credit" : null;
    if (!kind) continue;

    const key = orphanIndexKey(kind, transaction.amount);
    const existing = orphanIndex.get(key);
    if (existing) {
      existing.push(transaction);
    } else {
      orphanIndex.set(key, [transaction]);
    }
  }

  const seenPairs = new Set<string>();
  const results: MislinkedTransferMatch[] = [];

  for (const transaction of transactions) {
    const pairId = transaction.transfer_transaction_id;
    if (!pairId) continue;
    if (!transaction.transfer_account_id) continue;

    const other = transactionsById.get(pairId);
    if (!other) continue;

    const pairKey = [transaction.id, other.id].sort().join("|");
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const accountA = accountById.get(transaction.account_id);
    const accountB = accountById.get(other.account_id);
    if (!accountA || !accountB) continue;

    const isACash = isCheckingOrSavings(accountA);
    const isBCash = isCheckingOrSavings(accountB);
    const isACredit = isCredit(accountA);
    const isBCredit = isCredit(accountB);

    if (!((isACash && isBCredit) || (isBCash && isACredit))) continue;

    if (!isDirectImportActive(accountA) || !isDirectImportActive(accountB)) continue;

    const aHasImport = Boolean(transaction.import_id);
    const bHasImport = Boolean(other.import_id);

    if (aHasImport && bHasImport) continue;
    if (!aHasImport && !bHasImport) continue;

    const aCleared = transaction.cleared === "cleared";
    const bCleared = other.cleared === "cleared";

    let anchor: TransactionDetail | null = null;
    let phantom: TransactionDetail | null = null;
    let phantomAccount: Account | undefined;

    if (aHasImport && aCleared && !bHasImport && other.cleared === "uncleared") {
      anchor = transaction;
      phantom = other;
      phantomAccount = accountB;
    } else if (bHasImport && bCleared && !aHasImport && transaction.cleared === "uncleared") {
      anchor = other;
      phantom = transaction;
      phantomAccount = accountA;
    } else {
      continue;
    }

    if (!anchor || !phantom || !phantomAccount) continue;

    const phantomKind = isCheckingOrSavings(phantomAccount)
      ? "cash"
      : isCredit(phantomAccount)
        ? "credit"
        : null;
    if (!phantomKind) continue;

    const orphanKey = orphanIndexKey(phantomKind, phantom.amount);
    const candidates = orphanIndex.get(orphanKey) ?? [];
    const orphanCandidates = candidates.filter((candidate) => {
      if (candidate.account_id === phantom.account_id) return false;
      if (!withinDayDelta(candidate.date, phantom.date, options.importLagDays)) return false;
      return true;
    });

    if (orphanCandidates.length === 0) continue;

    results.push({
      anchor,
      phantom,
      orphan_candidates: orphanCandidates,
    });
  }

  return results;
}

export type { MislinkedTransferMatch, MislinkedTransferOptions };
