import { Writable } from "node:stream";

import { expect, test } from "bun:test";
import type { CurrencyFormat, TransactionDetail } from "ynab";

import {
  isActionableUncategorizedTransaction,
  writeMislinkedTransfers,
  writeReviewSummary,
} from "@/cli/commands/review";
import type { MislinkedTransferMatch } from "@/domain/mislinkedTransfers";

function createCapture() {
  let data = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    output: () => data,
  };
}

const USD_FORMAT: CurrencyFormat = {
  iso_code: "USD",
  example_format: "$1,234.56",
  decimal_digits: 2,
  decimal_separator: ".",
  symbol_first: true,
  group_separator: ",",
  currency_symbol: "$",
  display_symbol: true,
};

function makeTransaction(overrides: Partial<TransactionDetail>): TransactionDetail {
  return {
    id: "t1",
    date: "2026-01-01",
    amount: -5000,
    cleared: "cleared",
    approved: false,
    account_id: "acc1",
    deleted: false,
    account_name: "Checking",
    transfer_account_id: null,
    transfer_transaction_id: null,
    subtransactions: [],
    ...overrides,
  };
}

type SubTransaction = NonNullable<TransactionDetail["subtransactions"]>[number];

function makeSubtransaction(overrides: Partial<SubTransaction> = {}): SubTransaction {
  return {
    id: "sub-1",
    transaction_id: "t1",
    amount: -1000,
    memo: null,
    payee_id: null,
    payee_name: null,
    category_id: "cat-1",
    category_name: "Groceries",
    transfer_account_id: null,
    deleted: false,
    ...overrides,
  };
}

function makeMatch(): MislinkedTransferMatch {
  const anchor = makeTransaction({
    id: "anchor",
    date: "2026-01-22",
    amount: 76190,
    cleared: "cleared",
    account_id: "acc-credit",
    account_name: "A Amex",
    import_id: "YNAB:76190:2026-01-22:1",
  });

  const phantom = makeTransaction({
    id: "phantom",
    date: "2026-01-22",
    amount: -76190,
    cleared: "uncleared",
    account_id: "acc-checking",
    account_name: "J BoA Checking",
  });

  const orphan = makeTransaction({
    id: "orphan",
    date: "2026-01-22",
    amount: -76190,
    cleared: "cleared",
    account_id: "acc-checking-2",
    account_name: "A BoA Checking",
    import_id: "YNAB:-76190:2026-01-22:1",
  });

  return {
    anchor,
    phantom,
    orphan_candidates: [orphan],
  };
}

test("review mislinked transfers writes json output", () => {
  const capture = createCapture();
  const refsById = new Map([
    ["anchor", "R1"],
    ["phantom", "R2"],
    ["orphan", "R3"],
  ]);
  writeMislinkedTransfers([makeMatch()], "json", {
    stdout: capture.stream,
    refsById,
  });

  const payload = JSON.parse(capture.output()) as Array<{
    anchor: { id: string; ref: string | null };
    phantom: { id: string; ref: string | null };
    orphan_candidates: Array<{ id: string; ref: string | null }>;
  }>;

  expect(payload).toHaveLength(1);
  expect(payload[0]?.anchor.id).toBe("anchor");
  expect(payload[0]?.anchor.ref).toBe("R1");
  expect(payload[0]?.phantom.id).toBe("phantom");
  expect(payload[0]?.phantom.ref).toBe("R2");
  expect(payload[0]?.orphan_candidates[0]?.id).toBe("orphan");
  expect(payload[0]?.orphan_candidates[0]?.ref).toBe("R3");
});

test("review mislinked transfers writes tsv output", () => {
  const capture = createCapture();
  const refsById = new Map([
    ["anchor", "R1"],
    ["phantom", "R2"],
    ["orphan", "R3"],
  ]);
  writeMislinkedTransfers([makeMatch()], "tsv", {
    stdout: capture.stream,
    currencyFormat: USD_FORMAT,
    refsById,
  });

  expect(capture.output()).toBe(
    "amount\tanchorAccount\tanchorId\tdate\torphanAccounts\torphanIds\tphantomAccount\tphantomId\n" +
      "$76.19\tA Amex\tR1\t2026-01-22\tA BoA Checking\tR3\tJ BoA Checking\tR2\n",
  );
});

test("review mislinked transfers writes ids output", () => {
  const capture = createCapture();
  writeMislinkedTransfers([makeMatch()], "ids", { stdout: capture.stream });
  expect(capture.output()).toBe("phantom\n");
});

test("actionable uncategorized excludes transfers", () => {
  const transfer = makeTransaction({
    category_id: null,
    category_name: null,
    transfer_account_id: "acc2",
    transfer_transaction_id: "tx2",
  });

  expect(isActionableUncategorizedTransaction(transfer)).toBe(false);
});

test("actionable uncategorized excludes split parent with categorized subtransactions", () => {
  const splitParent = makeTransaction({
    id: "split-parent",
    category_id: null,
    category_name: null,
    subtransactions: [
      makeSubtransaction({
        id: "sub-1",
        transaction_id: "split-parent",
        category_id: "cat-1",
        category_name: "Groceries",
      }),
    ],
  });

  expect(isActionableUncategorizedTransaction(splitParent)).toBe(false);
});

test("actionable uncategorized includes split parent with uncategorized subtransaction", () => {
  const splitParent = makeTransaction({
    id: "split-parent",
    category_id: null,
    category_name: null,
    subtransactions: [
      makeSubtransaction({
        id: "sub-1",
        transaction_id: "split-parent",
        category_id: null,
        category_name: null,
      }),
    ],
  });

  expect(isActionableUncategorizedTransaction(splitParent)).toBe(true);
});

test("review summary writes json output", () => {
  const capture = createCapture();
  writeReviewSummary(
    {
      since_date: "2026-01-01",
      overspent_categories: [
        {
          id: "cat-1",
          category_group: "Bills",
          category_name: "Electric",
          budgeted_milliunits: 100_000,
          activity_milliunits: -120_000,
          balance_milliunits: -20_000,
        },
      ],
      uncategorized_transactions: [
        {
          id: "tx-1",
          date: "2026-01-15",
          payee: "Merchant A",
          amount_milliunits: -5_000,
          account: "Checking",
        },
      ],
      unapproved_transactions: [
        {
          id: "tx-2",
          date: "2026-01-20",
          payee: "Merchant B",
          amount_milliunits: -10_000,
          account: "Visa",
        },
      ],
    },
    "json",
    { stdout: capture.stream },
  );

  const payload = JSON.parse(capture.output()) as {
    since_date: string;
    overspent_categories: Array<{ id: string }>;
    uncategorized_transactions: Array<{ id: string }>;
    unapproved_transactions: Array<{ id: string }>;
  };

  expect(payload.since_date).toBe("2026-01-01");
  expect(payload.overspent_categories.map((item) => item.id)).toEqual(["cat-1"]);
  expect(payload.uncategorized_transactions.map((item) => item.id)).toEqual(["tx-1"]);
  expect(payload.unapproved_transactions.map((item) => item.id)).toEqual(["tx-2"]);
});

test("review summary writes ids output with unique ids", () => {
  const capture = createCapture();
  writeReviewSummary(
    {
      since_date: "2026-01-01",
      overspent_categories: [
        {
          id: "cat-1",
          category_group: "Bills",
          category_name: "Electric",
          budgeted_milliunits: 100_000,
          activity_milliunits: -120_000,
          balance_milliunits: -20_000,
        },
      ],
      uncategorized_transactions: [
        {
          id: "tx-1",
          date: "2026-01-15",
          payee: "Merchant A",
          amount_milliunits: -5_000,
          account: "Checking",
        },
      ],
      unapproved_transactions: [
        {
          id: "tx-1",
          date: "2026-01-15",
          payee: "Merchant A",
          amount_milliunits: -5_000,
          account: "Checking",
        },
      ],
    },
    "ids",
    { stdout: capture.stream },
  );

  expect(capture.output()).toBe("cat-1\ntx-1\n");
});

test("review summary writes table output with section summaries", () => {
  const capture = createCapture();
  writeReviewSummary(
    {
      since_date: "2026-01-01",
      overspent_categories: [],
      uncategorized_transactions: [
        {
          id: "tx-1",
          date: "2026-01-15",
          payee: "Merchant A",
          amount_milliunits: -5_000,
          account: "Checking",
        },
      ],
      unapproved_transactions: [],
    },
    "table",
    {
      stdout: capture.stream,
      noColor: true,
      currencyFormat: USD_FORMAT,
    },
  );

  const output = capture.output();
  expect(output).toContain("Overspent Categories: 0");
  expect(output).toContain("Uncategorized Transactions (since 2026-01-01): 1");
  expect(output).toContain("Unapproved Transactions (since 2026-01-01): 0");
  expect(output).toContain("Merchant A");
  expect(output).toContain("-$5.00");
});
