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
    subtransactions: [],
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
