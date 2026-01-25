import type { Account, TransactionDetail } from "ynab";

import { withinDayDelta } from "@/domain/dateOnly";
import { isCheckingOrSavings, isCredit } from "@/domain/ynab/accountPredicates";

export type AccountKind = "cash" | "credit";

export function accountKind(account: Account | undefined): AccountKind | null {
  if (isCheckingOrSavings(account)) return "cash";
  if (isCredit(account)) return "credit";
  return null;
}

export function isCashCreditPair(
  accountA: Account | undefined,
  accountB: Account | undefined,
): boolean {
  const kindA = accountKind(accountA);
  const kindB = accountKind(accountB);
  if (!kindA || !kindB) return false;
  return kindA !== kindB;
}

function isClearedLike(transaction: TransactionDetail): boolean {
  return transaction.cleared === "cleared" || transaction.cleared === "reconciled";
}

export function isAnchorTransaction(transaction: TransactionDetail): boolean {
  return Boolean(transaction.import_id && isClearedLike(transaction));
}

export function isPhantomTransaction(transaction: TransactionDetail): boolean {
  return !transaction.import_id && transaction.cleared === "uncleared";
}

export function isOrphanCandidate(
  transaction: TransactionDetail,
  options: { requireTransferTransactionId?: boolean } = {},
): boolean {
  if (transaction.transfer_account_id) return false;
  if (options.requireTransferTransactionId && transaction.transfer_transaction_id) return false;
  return Boolean(transaction.import_id && isClearedLike(transaction));
}

export function orphanMatchesPhantom(
  orphan: TransactionDetail,
  phantom: TransactionDetail,
  importLagDays: number,
): boolean {
  if (orphan.account_id === phantom.account_id) return false;
  if (orphan.amount !== phantom.amount) return false;
  return withinDayDelta(orphan.date, phantom.date, importLagDays);
}
