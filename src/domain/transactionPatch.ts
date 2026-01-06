import type { TransactionPatch } from "@/api/YnabClient";
import type { TransactionDetail } from "ynab";

export function isTransactionPatchNoop(
  transaction: TransactionDetail,
  patch: TransactionPatch,
): boolean {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return true;

  for (const [key, value] of entries) {
    const current = (transaction as unknown as Record<string, unknown>)[key];
    if (value === null && (current === null || current === undefined)) continue;
    if (current !== value) return false;
  }

  return true;
}

export function applyIdempotency(
  transaction: TransactionDetail,
  patch: TransactionPatch,
): TransactionPatch | null {
  return isTransactionPatchNoop(transaction, patch) ? null : patch;
}

export function buildInversePatch(
  transaction: TransactionDetail,
  patch: TransactionPatch,
): TransactionPatch {
  const inverse: TransactionPatch = {};
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  for (const [key, value] of entries) {
    const current = (transaction as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (current === undefined) {
      (inverse as Record<string, unknown>)[key] = null;
    } else {
      (inverse as Record<string, unknown>)[key] = current;
    }
  }
  return inverse;
}
