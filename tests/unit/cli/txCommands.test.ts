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

test("transaction filters apply account and uncategorized rules", () => {
  const categorized = makeTransaction({ id: "t1", account_id: "acc1", category_id: "cat1" });
  const uncategorized = makeTransaction({ id: "t2", account_id: "acc2", category_id: null });

  const byAccount = applyTransactionFilters([categorized, uncategorized], { accountId: "acc1" });
  expect(byAccount.map((tx) => tx.id)).toEqual(["t1"]);

  const onlyUncategorized = applyTransactionFilters([categorized, uncategorized], {
    uncategorized: true,
  });
  expect(onlyUncategorized.map((tx) => tx.id)).toEqual(["t2"]);
});

test("transaction detail writes ids output", () => {
  const transaction = makeTransaction({ id: "t9" });

  const capture = createCapture();
  writeTransactionDetail(transaction, "ids", { stdout: capture.stream });

  expect(capture.output()).toBe("t9\n");
});
