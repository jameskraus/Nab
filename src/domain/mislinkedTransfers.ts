import type { Account, TransactionDetail } from "ynab";

import {
  accountKind,
  isAnchorTransaction,
  isCashCreditPair,
  isOrphanCandidate,
  isPhantomTransaction,
  orphanMatchesPhantom,
} from "@/domain/mislinkedTransferPredicates";
import { isDirectImportActive } from "@/domain/ynab/accountPredicates";

type OrphanCandidate = TransactionDetail;

type MislinkedTransferMatch = {
  anchor: TransactionDetail;
  phantom: TransactionDetail;
  orphan_candidates: OrphanCandidate[];
};

type MislinkedTransferOptions = {
  importLagDays: number;
};

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
    if (!isOrphanCandidate(transaction)) continue;

    const account = accountById.get(transaction.account_id);
    if (!account) continue;
    if (!isDirectImportActive(account)) continue;

    const kind = accountKind(account);
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

    if (!isCashCreditPair(accountA, accountB)) continue;

    if (!isDirectImportActive(accountA) || !isDirectImportActive(accountB)) continue;

    let anchor: TransactionDetail | null = null;
    let phantom: TransactionDetail | null = null;
    let phantomAccount: Account | undefined;

    if (isAnchorTransaction(transaction) && isPhantomTransaction(other)) {
      anchor = transaction;
      phantom = other;
      phantomAccount = accountB;
    } else if (isAnchorTransaction(other) && isPhantomTransaction(transaction)) {
      anchor = other;
      phantom = transaction;
      phantomAccount = accountA;
    } else {
      continue;
    }

    if (!anchor || !phantom || !phantomAccount) continue;

    const phantomKind = accountKind(phantomAccount);
    if (!phantomKind) continue;

    const orphanKey = orphanIndexKey(phantomKind, phantom.amount);
    const candidates = orphanIndex.get(orphanKey) ?? [];
    const orphanCandidates = candidates.filter((candidate) =>
      orphanMatchesPhantom(candidate, phantom, options.importLagDays),
    );

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
