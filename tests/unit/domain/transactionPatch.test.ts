import { expect, test } from "bun:test";
import type { TransactionDetail } from "ynab";

import { applyIdempotency, isTransactionPatchNoop } from "@/domain/transactionPatch";

function makeTransaction(overrides: Partial<TransactionDetail>): TransactionDetail {
  return {
    id: "t1",
    date: "2026-01-01",
    amount: -1000,
    cleared: "cleared",
    approved: true,
    account_id: "acc1",
    deleted: false,
    account_name: "Checking",
    subtransactions: [],
    ...overrides,
  };
}

test("isTransactionPatchNoop returns true when patch matches", () => {
  const transaction = makeTransaction({ approved: true });
  expect(isTransactionPatchNoop(transaction, { approved: true })).toBe(true);
});

test("isTransactionPatchNoop returns false when patch differs", () => {
  const transaction = makeTransaction({ approved: false });
  expect(isTransactionPatchNoop(transaction, { approved: true })).toBe(false);
});

test("applyIdempotency returns null for noop patch", () => {
  const transaction = makeTransaction({ approved: true });
  expect(applyIdempotency(transaction, { approved: true })).toBeNull();
});

test("applyIdempotency treats null and undefined as equal", () => {
  const transaction = makeTransaction({ memo: undefined });
  expect(applyIdempotency(transaction, { memo: null })).toBeNull();
});
