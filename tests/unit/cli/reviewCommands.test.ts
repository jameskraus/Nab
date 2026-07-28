import { Writable } from "node:stream";

import { expect, test } from "bun:test";
import type { CurrencyFormat, TransactionDetail } from "ynab";

import { writeMislinkedTransfers } from "@/cli/commands/review";
import type { MislinkedTransferMatch } from "@/domain/mislinkedTransfers";

function createCapture() {
  let data = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  return { stream, output: () => data };
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

function transaction(overrides: Partial<TransactionDetail>): TransactionDetail {
  return {
    id: "transaction",
    date: "2026-01-22",
    amount: -76_190,
    cleared: "cleared",
    approved: false,
    account_id: "account",
    deleted: false,
    account_name: "Checking",
    transfer_account_id: null,
    transfer_transaction_id: null,
    subtransactions: [],
    ...overrides,
  };
}

function match(): MislinkedTransferMatch {
  return {
    anchor: transaction({
      id: "anchor",
      amount: 76_190,
      account_id: "account-credit",
      account_name: "A Amex",
      import_id: "YNAB:76190:2026-01-22:1",
    }),
    phantom: transaction({
      id: "phantom",
      account_id: "account-checking",
      account_name: "J BoA Checking",
      cleared: "uncleared",
    }),
    orphan_candidates: [
      transaction({
        id: "orphan",
        account_id: "account-checking-2",
        account_name: "A BoA Checking",
        import_id: "YNAB:-76190:2026-01-22:1",
      }),
    ],
  };
}

test("review mislinked transfers writes json output with refs", () => {
  const capture = createCapture();
  writeMislinkedTransfers([match()], "json", {
    stdout: capture.stream,
    refsById: new Map([
      ["anchor", "R1"],
      ["phantom", "R2"],
      ["orphan", "R3"],
    ]),
  });

  const payload = JSON.parse(capture.output()) as Array<{
    anchor: { id: string; ref: string | null };
    phantom: { id: string; ref: string | null };
    orphan_candidates: Array<{ id: string; ref: string | null }>;
  }>;
  expect(payload[0]?.anchor).toMatchObject({ id: "anchor", ref: "R1" });
  expect(payload[0]?.phantom).toMatchObject({ id: "phantom", ref: "R2" });
  expect(payload[0]?.orphan_candidates[0]).toMatchObject({ id: "orphan", ref: "R3" });
});

test("review mislinked transfers writes tsv output", () => {
  const capture = createCapture();
  writeMislinkedTransfers([match()], "tsv", {
    stdout: capture.stream,
    currencyFormat: USD_FORMAT,
    refsById: new Map([
      ["anchor", "R1"],
      ["phantom", "R2"],
      ["orphan", "R3"],
    ]),
  });

  expect(capture.output()).toBe(
    "amount\tanchorAccount\tanchorId\tdate\torphanAccounts\torphanIds\tphantomAccount\tphantomId\n" +
      "$76.19\tA Amex\tR1\t2026-01-22\tA BoA Checking\tR3\tJ BoA Checking\tR2\n",
  );
});

test("review mislinked transfers ids output contains only phantom ids", () => {
  const capture = createCapture();
  writeMislinkedTransfers([match()], "ids", { stdout: capture.stream });
  expect(capture.output()).toBe("phantom\n");
});
