import { Writable } from "node:stream";

import { expect, test } from "bun:test";
import type {
  Account,
  BudgetSummary,
  CategoryGroupWithCategories,
  CurrencyFormat,
  Payee,
} from "ynab";

import { writeAccountList } from "@/cli/commands/account";
import { writeBudgetCurrent, writeBudgetList } from "@/cli/commands/budget";
import { writeCategoryList } from "@/cli/commands/category";
import { writePayeeList } from "@/cli/commands/payee";

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

test("budget list writes tsv output", () => {
  const budgets: BudgetSummary[] = [
    {
      id: "b1",
      name: "Home",
      last_modified_on: "2026-01-01T00:00:00Z",
      first_month: "2025-01-01",
      last_month: "2025-12-01",
    },
  ];

  const capture = createCapture();
  writeBudgetList(budgets, "tsv", { stdout: capture.stream });

  expect(capture.output()).toBe(
    "firstMonth\tid\tlastModified\tlastMonth\tname\n2025-01-01\tb1\t2026-01-01T00:00:00Z\t2025-12-01\tHome\n",
  );
});

test("budget current writes tsv output", () => {
  const capture = createCapture();
  writeBudgetCurrent("b1", "tsv", { stdout: capture.stream });

  expect(capture.output()).toBe("id\nb1\n");
});

test("account list writes tsv output", () => {
  const accounts: Account[] = [
    {
      id: "a1",
      name: "Checking",
      type: "checking",
      on_budget: true,
      closed: false,
      balance: 123_000,
      cleared_balance: 120_000,
      uncleared_balance: 3_000,
      transfer_payee_id: "payee-transfer",
      deleted: false,
    },
  ];

  const capture = createCapture();
  writeAccountList(accounts, "tsv", { stdout: capture.stream, currencyFormat: USD_FORMAT });

  expect(capture.output()).toBe(
    "balance\tclosed\tid\tname\tonBudget\ttype\n$123.00\tfalse\ta1\tChecking\ttrue\tchecking\n",
  );
});

test("category list writes tsv output", () => {
  const groups: CategoryGroupWithCategories[] = [
    {
      id: "cg1",
      name: "Bills",
      hidden: false,
      deleted: false,
      categories: [
        {
          id: "c1",
          category_group_id: "cg1",
          name: "Rent",
          hidden: false,
          budgeted: 0,
          activity: 0,
          balance: 500_000,
          deleted: false,
        },
      ],
    },
  ];

  const capture = createCapture();
  writeCategoryList(groups, "tsv", { stdout: capture.stream, currencyFormat: USD_FORMAT });

  expect(capture.output()).toBe(
    "balance\tdeleted\tgroup\thidden\tid\tname\n$500.00\tfalse\tBills\tfalse\tc1\tRent\n",
  );
});

test("payee list writes ids output", () => {
  const payees: Payee[] = [
    { id: "p1", name: "Landlord", deleted: false },
    { id: "p2", name: "Utilities", deleted: false },
  ];

  const capture = createCapture();
  writePayeeList(payees, "ids", { stdout: capture.stream });

  expect(capture.output()).toBe("p1\np2\n");
});
