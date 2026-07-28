import { expect, test } from "bun:test";
import type { SubTransaction, TransactionDetail } from "ynab";

import {
  buildTransactionReview,
  isActionableUncategorizedTransaction,
  transactionReviewKind,
} from "@/domain/transactionReview";
import { tx } from "../../helpers/ynabFixtures";

function subtransaction(overrides: Partial<SubTransaction> = {}): SubTransaction {
  return {
    id: "sub-1",
    transaction_id: "tx-1",
    amount: -1000,
    memo: null,
    payee_id: null,
    payee_name: null,
    category_id: "cat-1",
    category_name: "Groceries",
    transfer_account_id: null,
    transfer_transaction_id: null,
    deleted: false,
    ...overrides,
  };
}

function transaction(id: string, overrides: Partial<TransactionDetail> = {}): TransactionDetail {
  return tx({
    id,
    account_id: `account-${id}`,
    account_name: `J Account ${id}`,
    payee_id: `payee-${id}`,
    payee_name: `Payee ${id}`,
    category_id: "category-1",
    category_name: "Groceries",
    memo: `Memo ${id}`,
    approved: false,
    ...overrides,
  });
}

test("unions and deduplicates issue sources with overlap counts", () => {
  const approvalOnly = transaction("approval-only");
  const both = transaction("both", {
    category_id: null,
    category_name: "Uncategorized",
  });
  const uncategorizedOnly = transaction("uncategorized-only", {
    approved: true,
    category_id: null,
    category_name: null,
  });

  const review = buildTransactionReview({
    unapprovedTransactions: [approvalOnly, both, both],
    uncategorizedTransactions: [both, uncategorizedOnly, uncategorizedOnly],
  });

  expect(review.counts).toEqual({
    total: 3,
    returned: 3,
    unapproved: 2,
    uncategorized: 2,
    both: 1,
  });
  expect(review.truncated).toBe(false);
  expect(review.items.map(({ id, issues }) => ({ id, issues }))).toEqual([
    { id: "approval-only", issues: ["unapproved"] },
    { id: "both", issues: ["unapproved", "uncategorized"] },
    { id: "uncategorized-only", issues: ["uncategorized"] },
  ]);
});

test("includes agent-facing transaction fields and normalizes absent values", () => {
  const source = transaction("details", {
    date: "2026-07-20",
    amount: -12_345,
    account_id: "account-1",
    account_name: "J Checking",
    payee_id: "payee-1",
    payee_name: "Renamed Payee",
    import_payee_name: "Imported Payee",
    import_payee_name_original: "ORIGINAL PAYEE",
    category_id: "category-1",
    category_name: "Groceries",
    memo: "weekly shop",
    import_id: "YNAB:-12345:2026-07-20:1",
    approved: false,
    cleared: "reconciled",
  });

  const review = buildTransactionReview({
    unapprovedTransactions: [source],
    uncategorizedTransactions: [],
  });

  expect(review.items[0]).toEqual({
    id: "details",
    date: "2026-07-20",
    account_id: "account-1",
    account_name: "J Checking",
    payee_id: "payee-1",
    payee_name: "Renamed Payee",
    import_payee_name: "Imported Payee",
    import_payee_name_original: "ORIGINAL PAYEE",
    category_id: "category-1",
    category_name: "Groceries",
    memo: "weekly shop",
    import_id: "YNAB:-12345:2026-07-20:1",
    amount_milliunits: -12_345,
    approved: false,
    cleared: "reconciled",
    kind: "regular",
    issues: ["unapproved"],
    transfer_account_id: null,
    transfer_transaction_id: null,
    split_subtransaction_count: 0,
    split_uncategorized_subtransaction_count: 0,
    split_limitation: null,
  });

  const absent = transaction("absent", {
    payee_id: undefined,
    payee_name: undefined,
    import_payee_name: undefined,
    import_payee_name_original: undefined,
    category_id: undefined,
    category_name: undefined,
    memo: undefined,
    import_id: undefined,
  });
  const absentReview = buildTransactionReview({
    unapprovedTransactions: [absent],
    uncategorizedTransactions: [],
  });

  expect(absentReview.items[0]).toMatchObject({
    payee_id: null,
    payee_name: null,
    import_payee_name: null,
    import_payee_name_original: null,
    category_id: null,
    category_name: null,
    memo: null,
    import_id: null,
  });
});

test("filters by any requested account-name prefix before counting", () => {
  const james = transaction("james", { account_name: "J Checking" });
  const allison = transaction("allison", { account_name: "A Checking" });
  const shared = transaction("shared", { account_name: "Shared Checking" });

  const review = buildTransactionReview({
    unapprovedTransactions: [shared, allison, james],
    uncategorizedTransactions: [],
    accountNamePrefixes: ["J ", "A "],
  });

  expect(review.items.map((item) => item.id)).toEqual(["allison", "james"]);
  expect(review.counts.total).toBe(2);
});

test("orders approval-only regular, uncategorized regular, split, then transfer", () => {
  const approvalOnlyNew = transaction("approval-new", { date: "2026-07-20" });
  const approvalOnlyOld = transaction("approval-old", { date: "2026-07-01" });
  const both = transaction("both", {
    date: "2026-06-01",
    category_id: null,
    category_name: null,
  });
  const uncategorizedOnly = transaction("uncategorized", {
    date: "2026-05-01",
    approved: true,
    category_id: null,
    category_name: null,
  });
  const split = transaction("split", {
    date: "2026-04-01",
    subtransactions: [
      subtransaction({
        transaction_id: "split",
        category_id: null,
        category_name: null,
      }),
    ],
  });
  const transfer = transaction("transfer", {
    date: "2026-03-01",
    category_id: null,
    category_name: null,
    transfer_account_id: "account-other",
    transfer_transaction_id: "transfer-other",
  });

  const review = buildTransactionReview({
    unapprovedTransactions: [transfer, both, approvalOnlyNew, split, approvalOnlyOld],
    uncategorizedTransactions: [uncategorizedOnly, both, split, transfer],
  });

  expect(review.items.map((item) => item.id)).toEqual([
    "approval-old",
    "approval-new",
    "uncategorized",
    "both",
    "split",
    "transfer",
  ]);
  expect(review.items.map((item) => item.kind)).toEqual([
    "regular",
    "regular",
    "regular",
    "regular",
    "split",
    "transfer",
  ]);
  expect(review.items.at(-1)?.issues).toEqual(["unapproved"]);
});

test("uses account, payee, and id as deterministic same-date tie breakers", () => {
  const zAccount = transaction("z-id", {
    date: "2026-07-01",
    account_name: "Z Account",
    payee_name: "A Payee",
  });
  const bPayee = transaction("b-id", {
    date: "2026-07-01",
    account_name: "A Account",
    payee_name: "B Payee",
  });
  const aPayeeZId = transaction("z-second-id", {
    date: "2026-07-01",
    account_name: "A Account",
    payee_name: "A Payee",
  });
  const aPayeeAId = transaction("a-first-id", {
    date: "2026-07-01",
    account_name: "A Account",
    payee_name: "A Payee",
  });

  const review = buildTransactionReview({
    unapprovedTransactions: [zAccount, bPayee, aPayeeZId, aPayeeAId],
    uncategorizedTransactions: [],
  });

  expect(review.items.map((item) => item.id)).toEqual([
    "a-first-id",
    "z-second-id",
    "b-id",
    "z-id",
  ]);
});

test("limits returned items while retaining pre-limit counts", () => {
  const approvalOnly = transaction("approval-only");
  const both = transaction("both", {
    category_id: null,
    category_name: null,
  });
  const uncategorizedOnly = transaction("uncategorized-only", {
    approved: true,
    category_id: null,
    category_name: null,
  });

  const review = buildTransactionReview({
    unapprovedTransactions: [both, approvalOnly],
    uncategorizedTransactions: [uncategorizedOnly, both],
    limit: 2,
  });

  expect(review.items.map((item) => item.id)).toEqual(["approval-only", "both"]);
  expect(review.counts).toEqual({
    total: 3,
    returned: 2,
    unapproved: 2,
    uncategorized: 2,
    both: 1,
  });
  expect(review.truncated).toBe(true);
});

test("allows a zero limit as a counts-only review", () => {
  const review = buildTransactionReview({
    unapprovedTransactions: [transaction("one")],
    uncategorizedTransactions: [],
    limit: 0,
  });

  expect(review.items).toEqual([]);
  expect(review.counts).toEqual({
    total: 1,
    returned: 0,
    unapproved: 1,
    uncategorized: 0,
    both: 0,
  });
  expect(review.truncated).toBe(true);
});

test("rejects invalid limits", () => {
  expect(() =>
    buildTransactionReview({
      unapprovedTransactions: [],
      uncategorizedTransactions: [],
      limit: -1,
    }),
  ).toThrow("Transaction review limit must be a non-negative integer");
  expect(() =>
    buildTransactionReview({
      unapprovedTransactions: [],
      uncategorizedTransactions: [],
      limit: 1.5,
    }),
  ).toThrow("Transaction review limit must be a non-negative integer");
});

test("drops deleted and ineligible source rows", () => {
  const deleted = transaction("deleted", { deleted: true });
  const alreadyApproved = transaction("approved", { approved: true });
  const categorized = transaction("categorized", { approved: true });
  const transfer = transaction("transfer", {
    approved: true,
    category_id: null,
    transfer_account_id: "other-account",
  });

  const review = buildTransactionReview({
    unapprovedTransactions: [deleted, alreadyApproved],
    uncategorizedTransactions: [deleted, categorized, transfer],
  });

  expect(review.items).toEqual([]);
  expect(review.counts.total).toBe(0);
});

test("classifies split details and marks unsupported split editing", () => {
  const split = transaction("split", {
    category_id: null,
    category_name: "Split",
    subtransactions: [
      subtransaction({
        id: "categorized-sub",
        transaction_id: "split",
      }),
      subtransaction({
        id: "uncategorized-sub",
        transaction_id: "split",
        category_id: null,
        category_name: null,
      }),
      subtransaction({
        id: "deleted-uncategorized-sub",
        transaction_id: "split",
        category_id: null,
        category_name: null,
        deleted: true,
      }),
    ],
  });

  const review = buildTransactionReview({
    unapprovedTransactions: [split],
    uncategorizedTransactions: [split],
  });

  expect(review.items[0]).toMatchObject({
    kind: "split",
    issues: ["unapproved", "uncategorized"],
    split_subtransaction_count: 2,
    split_uncategorized_subtransaction_count: 1,
    split_limitation: "split_editing_not_supported",
  });
});

test("does not treat transfer subtransactions as actionable uncategorized", () => {
  const splitWithTransfer = transaction("split-transfer", {
    approved: true,
    category_id: null,
    category_name: "Split",
    subtransactions: [
      subtransaction({
        transaction_id: "split-transfer",
        category_id: null,
        category_name: null,
        transfer_account_id: "other-account",
        transfer_transaction_id: "other-transaction",
      }),
    ],
  });

  expect(transactionReviewKind(splitWithTransfer)).toBe("split");
  expect(isActionableUncategorizedTransaction(splitWithTransfer)).toBe(false);
});

test("classifies top-level transfers ahead of split metadata", () => {
  const transfer = transaction("transfer", {
    transfer_account_id: "other-account",
    transfer_transaction_id: "other-transaction",
    subtransactions: [subtransaction({ transaction_id: "transfer" })],
  });

  expect(transactionReviewKind(transfer)).toBe("transfer");
});
