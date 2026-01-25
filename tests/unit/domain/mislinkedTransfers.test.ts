import { expect, test } from "bun:test";
import type { Account, TransactionDetail } from "ynab";

import { findMislinkedTransfers } from "@/domain/mislinkedTransfers";

function makeAccount(overrides: Partial<Account>): Account {
  return {
    id: "acc-1",
    name: "Account",
    type: "checking",
    on_budget: true,
    closed: false,
    balance: 0,
    cleared_balance: 0,
    uncleared_balance: 0,
    transfer_payee_id: null,
    deleted: false,
    direct_import_linked: true,
    direct_import_in_error: false,
    ...overrides,
  };
}

function makeTransaction(overrides: Partial<TransactionDetail>): TransactionDetail {
  return {
    id: "tx-1",
    date: "2026-01-01",
    amount: -1000,
    cleared: "cleared",
    approved: false,
    account_id: "acc-1",
    account_name: "Account",
    deleted: false,
    subtransactions: [],
    ...overrides,
  };
}

test("detects the worked example", () => {
  const jChecking = makeAccount({ id: "j-checking", name: "J BoA Checking", type: "checking" });
  const aChecking = makeAccount({ id: "a-checking", name: "A BoA Checking", type: "checking" });
  const aAmex = makeAccount({ id: "a-amex", name: "A Amex Hilton Honors", type: "creditCard" });

  const anchor = makeTransaction({
    id: "3527e89c-53b0-4dd3-9764-2186257941b8",
    date: "2026-01-22",
    amount: 76190,
    cleared: "cleared",
    account_id: aAmex.id,
    account_name: aAmex.name,
    transfer_account_id: jChecking.id,
    transfer_transaction_id: "b3bcbbd1-b716-491f-815e-4193821839b1",
    import_id: "YNAB:76190:2026-01-22:1",
  });

  const phantom = makeTransaction({
    id: "b3bcbbd1-b716-491f-815e-4193821839b1",
    date: "2026-01-22",
    amount: -76190,
    cleared: "uncleared",
    account_id: jChecking.id,
    account_name: jChecking.name,
    transfer_account_id: aAmex.id,
    transfer_transaction_id: "3527e89c-53b0-4dd3-9764-2186257941b8",
  });

  const orphan = makeTransaction({
    id: "8000d6b1-1d7f-4e5e-8c8d-44949827e629",
    date: "2026-01-22",
    amount: -76190,
    cleared: "cleared",
    account_id: aChecking.id,
    account_name: aChecking.name,
    import_id: "YNAB:-76190:2026-01-22:1",
  });

  const results = findMislinkedTransfers([jChecking, aChecking, aAmex], [anchor, phantom, orphan], {
    importLagDays: 5,
  });

  expect(results).toHaveLength(1);
  expect(results[0]?.anchor.id).toBe(anchor.id);
  expect(results[0]?.phantom.id).toBe(phantom.id);
  expect(results[0]?.orphan_candidates.map((tx) => tx.id)).toEqual([orphan.id]);
});

test("skips when no orphan exists", () => {
  const checking = makeAccount({ id: "checking", type: "checking" });
  const credit = makeAccount({ id: "credit", type: "creditCard" });

  const anchor = makeTransaction({
    id: "anchor",
    date: "2026-01-22",
    amount: 5000,
    cleared: "cleared",
    account_id: credit.id,
    account_name: credit.name,
    import_id: "YNAB:5000:2026-01-22:1",
    transfer_account_id: checking.id,
    transfer_transaction_id: "phantom",
  });

  const phantom = makeTransaction({
    id: "phantom",
    date: "2026-01-22",
    amount: -5000,
    cleared: "uncleared",
    account_id: checking.id,
    account_name: checking.name,
    transfer_account_id: credit.id,
    transfer_transaction_id: "anchor",
  });

  const results = findMislinkedTransfers([checking, credit], [anchor, phantom], {
    importLagDays: 5,
  });
  expect(results).toHaveLength(0);
});

test("includes multiple orphan candidates", () => {
  const checking = makeAccount({ id: "checking", type: "checking" });
  const checking2 = makeAccount({ id: "checking2", type: "checking" });
  const checking3 = makeAccount({ id: "checking3", type: "checking" });
  const credit = makeAccount({ id: "credit", type: "creditCard" });

  const anchor = makeTransaction({
    id: "anchor",
    date: "2026-01-22",
    amount: 9000,
    cleared: "cleared",
    account_id: credit.id,
    account_name: credit.name,
    import_id: "YNAB:9000:2026-01-22:1",
    transfer_account_id: checking.id,
    transfer_transaction_id: "phantom",
  });

  const phantom = makeTransaction({
    id: "phantom",
    date: "2026-01-22",
    amount: -9000,
    cleared: "uncleared",
    account_id: checking.id,
    account_name: checking.name,
    transfer_account_id: credit.id,
    transfer_transaction_id: "anchor",
  });

  const orphan1 = makeTransaction({
    id: "orphan-1",
    date: "2026-01-23",
    amount: -9000,
    cleared: "cleared",
    account_id: checking2.id,
    account_name: checking2.name,
    import_id: "YNAB:-9000:2026-01-23:1",
  });

  const orphan2 = makeTransaction({
    id: "orphan-2",
    date: "2026-01-24",
    amount: -9000,
    cleared: "cleared",
    account_id: checking3.id,
    account_name: checking3.name,
    import_id: "YNAB:-9000:2026-01-24:1",
  });

  const results = findMislinkedTransfers(
    [checking, checking2, checking3, credit],
    [anchor, phantom, orphan1, orphan2],
    { importLagDays: 5 },
  );

  expect(results).toHaveLength(1);
  expect(results[0]?.orphan_candidates.map((tx) => tx.id).sort()).toEqual([orphan1.id, orphan2.id]);
});

test("skips when both sides are imported", () => {
  const checking = makeAccount({ id: "checking", type: "checking" });
  const credit = makeAccount({ id: "credit", type: "creditCard" });

  const anchor = makeTransaction({
    id: "anchor",
    date: "2026-01-22",
    amount: 4000,
    cleared: "cleared",
    account_id: credit.id,
    account_name: credit.name,
    import_id: "YNAB:4000:2026-01-22:1",
    transfer_account_id: checking.id,
    transfer_transaction_id: "phantom",
  });

  const phantom = makeTransaction({
    id: "phantom",
    date: "2026-01-22",
    amount: -4000,
    cleared: "cleared",
    account_id: checking.id,
    account_name: checking.name,
    import_id: "YNAB:-4000:2026-01-22:1",
    transfer_account_id: credit.id,
    transfer_transaction_id: "anchor",
  });

  const orphan = makeTransaction({
    id: "orphan",
    date: "2026-01-22",
    amount: -4000,
    cleared: "cleared",
    account_id: "checking2",
    account_name: "Checking 2",
    import_id: "YNAB:-4000:2026-01-22:2",
  });

  const results = findMislinkedTransfers([checking, credit], [anchor, phantom, orphan], {
    importLagDays: 5,
  });
  expect(results).toHaveLength(0);
});

test("skips when both sides are missing import_id", () => {
  const checking = makeAccount({ id: "checking", type: "checking" });
  const credit = makeAccount({ id: "credit", type: "creditCard" });

  const anchor = makeTransaction({
    id: "anchor",
    date: "2026-01-22",
    amount: 3000,
    cleared: "uncleared",
    account_id: credit.id,
    account_name: credit.name,
    transfer_account_id: checking.id,
    transfer_transaction_id: "phantom",
  });

  const phantom = makeTransaction({
    id: "phantom",
    date: "2026-01-22",
    amount: -3000,
    cleared: "uncleared",
    account_id: checking.id,
    account_name: checking.name,
    transfer_account_id: credit.id,
    transfer_transaction_id: "anchor",
  });

  const orphan = makeTransaction({
    id: "orphan",
    date: "2026-01-22",
    amount: -3000,
    cleared: "cleared",
    account_id: "checking2",
    account_name: "Checking 2",
    import_id: "YNAB:-3000:2026-01-22:1",
  });

  const results = findMislinkedTransfers([checking, credit], [anchor, phantom, orphan], {
    importLagDays: 5,
  });
  expect(results).toHaveLength(0);
});

test("detects phantom on credit side", () => {
  const checking = makeAccount({ id: "checking", type: "checking" });
  const credit = makeAccount({ id: "credit", type: "creditCard" });
  const credit2 = makeAccount({ id: "credit-2", type: "creditCard" });

  const anchor = makeTransaction({
    id: "anchor",
    date: "2026-01-22",
    amount: -5000,
    cleared: "cleared",
    account_id: checking.id,
    account_name: checking.name,
    import_id: "YNAB:-5000:2026-01-22:1",
    transfer_account_id: credit.id,
    transfer_transaction_id: "phantom",
  });

  const phantom = makeTransaction({
    id: "phantom",
    date: "2026-01-22",
    amount: 5000,
    cleared: "uncleared",
    account_id: credit.id,
    account_name: credit.name,
    transfer_account_id: checking.id,
    transfer_transaction_id: "anchor",
  });

  const orphan = makeTransaction({
    id: "orphan",
    date: "2026-01-23",
    amount: 5000,
    cleared: "cleared",
    account_id: credit2.id,
    account_name: credit2.name,
    import_id: "YNAB:5000:2026-01-23:1",
  });

  const results = findMislinkedTransfers([checking, credit, credit2], [anchor, phantom, orphan], {
    importLagDays: 5,
  });

  expect(results).toHaveLength(1);
  expect(results[0]?.anchor.id).toBe(anchor.id);
  expect(results[0]?.phantom.id).toBe(phantom.id);
  expect(results[0]?.orphan_candidates.map((tx) => tx.id)).toEqual([orphan.id]);
});

test("skips when direct import is not active", () => {
  const checking = makeAccount({
    id: "checking",
    type: "checking",
    direct_import_linked: false,
  });
  const credit = makeAccount({ id: "credit", type: "creditCard" });

  const anchor = makeTransaction({
    id: "anchor",
    date: "2026-01-22",
    amount: 6000,
    cleared: "cleared",
    account_id: credit.id,
    account_name: credit.name,
    import_id: "YNAB:6000:2026-01-22:1",
    transfer_account_id: checking.id,
    transfer_transaction_id: "phantom",
  });

  const phantom = makeTransaction({
    id: "phantom",
    date: "2026-01-22",
    amount: -6000,
    cleared: "uncleared",
    account_id: checking.id,
    account_name: checking.name,
    transfer_account_id: credit.id,
    transfer_transaction_id: "anchor",
  });

  const orphan = makeTransaction({
    id: "orphan",
    date: "2026-01-22",
    amount: -6000,
    cleared: "cleared",
    account_id: "checking2",
    account_name: "Checking 2",
    import_id: "YNAB:-6000:2026-01-22:1",
  });

  const results = findMislinkedTransfers([checking, credit], [anchor, phantom, orphan], {
    importLagDays: 5,
  });
  expect(results).toHaveLength(0);
});
