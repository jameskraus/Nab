import { Writable } from "node:stream";

import { expect, test } from "bun:test";
import type { CurrencyFormat, TransactionDetail } from "ynab";

import {
  applyTransactionFilters,
  writeTransactionDetail,
  writeTransactionList,
} from "@/cli/commands/tx";

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
    approved: true,
    account_id: "acc1",
    deleted: false,
    account_name: "Checking",
    subtransactions: [],
    ...overrides,
  };
}

test("transaction list writes tsv output", () => {
  const transaction = makeTransaction({
    payee_name: "Market",
    category_id: "cat1",
    category_name: "Groceries",
    memo: "Lunch",
  });

  const capture = createCapture();
  writeTransactionList([transaction], "tsv", {
    stdout: capture.stream,
    currencyFormat: USD_FORMAT,
  });

  expect(capture.output()).toBe(
    "account\tamount\tcategory\tdate\tid\tmemo\tpayee\nChecking\t-$5.00\tGroceries\t2026-01-01\tt1\tLunch\tMarket\n",
  );
});

test("transaction list renders transfers with n/a category", () => {
  const transaction = makeTransaction({
    payee_name: "Transfer : Savings",
    transfer_account_id: "acc2",
    category_id: null,
    category_name: null,
  });

  const capture = createCapture();
  writeTransactionList([transaction], "tsv", {
    stdout: capture.stream,
    currencyFormat: USD_FORMAT,
  });

  expect(capture.output()).toContain("n/a - transfer");
});

test("transaction list renders transfers with null category in json", () => {
  const transaction = makeTransaction({
    payee_name: "Transfer : Savings",
    transfer_account_id: "acc2",
    category_id: "cat1",
    category_name: "Groceries",
  });

  const capture = createCapture();
  writeTransactionList([transaction], "json", {
    stdout: capture.stream,
    currencyFormat: USD_FORMAT,
  });

  const payload = JSON.parse(capture.output()) as Array<{
    category_id: string | null;
    category_name: string | null;
  }>;
  expect(payload[0]?.category_id).toBe(null);
  expect(payload[0]?.category_name).toBe(null);
});

test("transaction filters apply account, only-uncategorized, and only-unapproved rules", () => {
  const categorized = makeTransaction({
    id: "t1",
    account_id: "acc1",
    category_id: "cat1",
    approved: true,
  });
  const uncategorized = makeTransaction({
    id: "t2",
    account_id: "acc2",
    category_id: null,
    approved: true,
  });
  const unapproved = makeTransaction({
    id: "t3",
    account_id: "acc1",
    category_id: "cat2",
    approved: false,
  });
  const transfer = makeTransaction({
    id: "t4",
    account_id: "acc3",
    category_id: null,
    approved: true,
    transfer_account_id: "acc2",
  });

  const byAccount = applyTransactionFilters([categorized, uncategorized, unapproved, transfer], {
    accountId: "acc1",
  });
  expect(byAccount.map((tx) => tx.id)).toEqual(["t1", "t3"]);

  const onlyUncategorized = applyTransactionFilters(
    [categorized, uncategorized, unapproved, transfer],
    {
      onlyUncategorized: true,
    },
  );
  expect(onlyUncategorized.map((tx) => tx.id)).toEqual(["t2", "t4"]);

  const onlyUnapproved = applyTransactionFilters(
    [categorized, uncategorized, unapproved, transfer],
    {
      onlyUnapproved: true,
    },
  );
  expect(onlyUnapproved.map((tx) => tx.id)).toEqual(["t3"]);

  const onlyTransfers = applyTransactionFilters(
    [categorized, uncategorized, unapproved, transfer],
    {
      onlyTransfers: true,
    },
  );
  expect(onlyTransfers.map((tx) => tx.id)).toEqual(["t4"]);

  const excludeTransfers = applyTransactionFilters(
    [categorized, uncategorized, unapproved, transfer],
    {
      excludeTransfers: true,
    },
  );
  expect(excludeTransfers.map((tx) => tx.id)).toEqual(["t1", "t2", "t3"]);
});

test("transaction detail writes ids output", () => {
  const transaction = makeTransaction({ id: "t9" });

  const capture = createCapture();
  writeTransactionDetail(transaction, "ids", { stdout: capture.stream });

  expect(capture.output()).toBe("t9\n");
});
