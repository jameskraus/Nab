import { expect, test } from "bun:test";
import type { TransactionDetail } from "ynab";

import { findMislinkedTransfers } from "@/domain/mislinkedTransfers";
import { acc, linkedTransferPair, sortIds, tx } from "../../helpers/ynabFixtures";

const IMPORT_LAG_DAYS = 5;

type ClearedStatus = TransactionDetail["cleared"];

function expectMatch(
  results: ReturnType<typeof findMislinkedTransfers>,
  { anchorId, phantomId, orphanIds }: { anchorId: string; phantomId: string; orphanIds: string[] },
): void {
  expect(results).toHaveLength(1);
  const match = results[0];
  expect(match?.anchor.id).toBe(anchorId);
  expect(match?.phantom.id).toBe(phantomId);
  expect(sortIds(match?.orphan_candidates.map((candidate) => candidate.id) ?? [])).toEqual(
    sortIds(orphanIds),
  );
}

function buildStatusScenario({
  anchorCleared,
  phantomCleared,
  orphanCleared,
}: {
  anchorCleared: ClearedStatus;
  phantomCleared: ClearedStatus;
  orphanCleared: ClearedStatus;
}): {
  accounts: ReturnType<typeof acc>[];
  transactions: TransactionDetail[];
  anchor: TransactionDetail;
  phantom: TransactionDetail;
  orphan: TransactionDetail;
} {
  const credit = acc({ id: "credit", name: "Credit", type: "creditCard" });
  const phantomCash = acc({ id: "phantom-cash", name: "Phantom Cash", type: "checking" });
  const orphanCash = acc({ id: "orphan-cash", name: "Orphan Cash", type: "checking" });

  const { anchor, phantom } = linkedTransferPair({
    anchor: {
      id: "anchor",
      amount: 5000,
      cleared: anchorCleared,
      import_id: "YNAB:5000:2026-01-22:1",
    },
    phantom: {
      id: "phantom",
      amount: -5000,
      cleared: phantomCleared,
      import_id: null,
    },
    anchorAccount: credit,
    phantomAccount: phantomCash,
  });

  const orphan = tx({
    id: "orphan",
    account_id: orphanCash.id,
    account_name: orphanCash.name,
    amount: -5000,
    cleared: orphanCleared,
    import_id: "YNAB:-5000:2026-01-22:1",
  });

  return {
    accounts: [credit, phantomCash, orphanCash],
    transactions: [anchor, phantom, orphan],
    anchor,
    phantom,
    orphan,
  };
}

test("detects the worked example", () => {
  const jChecking = acc({ id: "j-checking", name: "J BoA Checking", type: "checking" });
  const aChecking = acc({ id: "a-checking", name: "A BoA Checking", type: "checking" });
  const aAmex = acc({ id: "a-amex", name: "A Amex Hilton Honors", type: "creditCard" });

  const { anchor, phantom } = linkedTransferPair({
    anchor: {
      id: "3527e89c-53b0-4dd3-9764-2186257941b8",
      date: "2026-01-22",
      amount: 76190,
      cleared: "cleared",
      import_id: "YNAB:76190:2026-01-22:1",
    },
    phantom: {
      id: "b3bcbbd1-b716-491f-815e-4193821839b1",
      date: "2026-01-22",
      amount: -76190,
      cleared: "uncleared",
    },
    anchorAccount: aAmex,
    phantomAccount: jChecking,
  });

  const orphan = tx({
    id: "8000d6b1-1d7f-4e5e-8c8d-44949827e629",
    date: "2026-01-22",
    amount: -76190,
    cleared: "cleared",
    account_id: aChecking.id,
    account_name: aChecking.name,
    import_id: "YNAB:-76190:2026-01-22:1",
  });

  const results = findMislinkedTransfers([jChecking, aChecking, aAmex], [anchor, phantom, orphan], {
    importLagDays: IMPORT_LAG_DAYS,
  });

  expectMatch(results, { anchorId: anchor.id, phantomId: phantom.id, orphanIds: [orphan.id] });
});

const statusCases: Array<{
  name: string;
  anchorCleared: ClearedStatus;
  phantomCleared: ClearedStatus;
  orphanCleared: ClearedStatus;
  expectMatch: boolean;
}> = [
  {
    name: "accepts reconciled anchor",
    anchorCleared: "reconciled",
    phantomCleared: "uncleared",
    orphanCleared: "cleared",
    expectMatch: true,
  },
  {
    name: "accepts reconciled orphan",
    anchorCleared: "cleared",
    phantomCleared: "uncleared",
    orphanCleared: "reconciled",
    expectMatch: true,
  },
  {
    name: "rejects reconciled phantom",
    anchorCleared: "cleared",
    phantomCleared: "reconciled",
    orphanCleared: "cleared",
    expectMatch: false,
  },
];

for (const testCase of statusCases) {
  test(testCase.name, () => {
    const scenario = buildStatusScenario(testCase);
    const results = findMislinkedTransfers(scenario.accounts, scenario.transactions, {
      importLagDays: IMPORT_LAG_DAYS,
    });

    if (!testCase.expectMatch) {
      expect(results).toHaveLength(0);
      return;
    }

    expectMatch(results, {
      anchorId: scenario.anchor.id,
      phantomId: scenario.phantom.id,
      orphanIds: [scenario.orphan.id],
    });
  });
}

test("skips when no orphan exists", () => {
  const checking = acc({ id: "checking", type: "checking" });
  const credit = acc({ id: "credit", type: "creditCard" });

  const { anchor, phantom } = linkedTransferPair({
    anchor: {
      id: "anchor",
      date: "2026-01-22",
      amount: 5000,
      cleared: "cleared",
      import_id: "YNAB:5000:2026-01-22:1",
    },
    phantom: {
      id: "phantom",
      date: "2026-01-22",
      amount: -5000,
      cleared: "uncleared",
    },
    anchorAccount: credit,
    phantomAccount: checking,
  });

  const results = findMislinkedTransfers([checking, credit], [anchor, phantom], {
    importLagDays: IMPORT_LAG_DAYS,
  });
  expect(results).toHaveLength(0);
});

test("includes multiple orphan candidates", () => {
  const checking = acc({ id: "checking", type: "checking" });
  const checking2 = acc({ id: "checking2", type: "checking" });
  const checking3 = acc({ id: "checking3", type: "checking" });
  const credit = acc({ id: "credit", type: "creditCard" });

  const { anchor, phantom } = linkedTransferPair({
    anchor: {
      id: "anchor",
      date: "2026-01-22",
      amount: 9000,
      cleared: "cleared",
      import_id: "YNAB:9000:2026-01-22:1",
    },
    phantom: {
      id: "phantom",
      date: "2026-01-22",
      amount: -9000,
      cleared: "uncleared",
    },
    anchorAccount: credit,
    phantomAccount: checking,
  });

  const orphan1 = tx({
    id: "orphan-1",
    date: "2026-01-23",
    amount: -9000,
    cleared: "cleared",
    account_id: checking2.id,
    account_name: checking2.name,
    import_id: "YNAB:-9000:2026-01-23:1",
  });

  const orphan2 = tx({
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
    { importLagDays: IMPORT_LAG_DAYS },
  );

  expectMatch(results, {
    anchorId: anchor.id,
    phantomId: phantom.id,
    orphanIds: [orphan1.id, orphan2.id],
  });
});

test("skips when both sides are imported", () => {
  const checking = acc({ id: "checking", type: "checking" });
  const credit = acc({ id: "credit", type: "creditCard" });
  const orphanAccount = acc({ id: "checking2", type: "checking" });

  const { anchor, phantom } = linkedTransferPair({
    anchor: {
      id: "anchor",
      date: "2026-01-22",
      amount: 4000,
      cleared: "cleared",
      import_id: "YNAB:4000:2026-01-22:1",
    },
    phantom: {
      id: "phantom",
      date: "2026-01-22",
      amount: -4000,
      cleared: "cleared",
      import_id: "YNAB:-4000:2026-01-22:1",
    },
    anchorAccount: credit,
    phantomAccount: checking,
  });

  const orphan = tx({
    id: "orphan",
    date: "2026-01-22",
    amount: -4000,
    cleared: "cleared",
    account_id: orphanAccount.id,
    account_name: orphanAccount.name,
    import_id: "YNAB:-4000:2026-01-22:2",
  });

  const results = findMislinkedTransfers(
    [checking, credit, orphanAccount],
    [anchor, phantom, orphan],
    {
      importLagDays: IMPORT_LAG_DAYS,
    },
  );
  expect(results).toHaveLength(0);
});

test("skips when both sides are missing import_id", () => {
  const checking = acc({ id: "checking", type: "checking" });
  const credit = acc({ id: "credit", type: "creditCard" });
  const orphanAccount = acc({ id: "checking2", type: "checking" });

  const { anchor, phantom } = linkedTransferPair({
    anchor: {
      id: "anchor",
      date: "2026-01-22",
      amount: 3000,
      cleared: "cleared",
      import_id: null,
    },
    phantom: {
      id: "phantom",
      date: "2026-01-22",
      amount: -3000,
      cleared: "uncleared",
      import_id: null,
    },
    anchorAccount: credit,
    phantomAccount: checking,
  });

  const orphan = tx({
    id: "orphan",
    date: "2026-01-22",
    amount: -3000,
    cleared: "cleared",
    account_id: orphanAccount.id,
    account_name: orphanAccount.name,
    import_id: "YNAB:-3000:2026-01-22:1",
  });

  const results = findMislinkedTransfers(
    [checking, credit, orphanAccount],
    [anchor, phantom, orphan],
    {
      importLagDays: IMPORT_LAG_DAYS,
    },
  );
  expect(results).toHaveLength(0);
});

test("detects phantom on credit side", () => {
  const checking = acc({ id: "checking", type: "checking" });
  const credit = acc({ id: "credit", type: "creditCard" });
  const credit2 = acc({ id: "credit-2", type: "creditCard" });

  const { anchor, phantom } = linkedTransferPair({
    anchor: {
      id: "anchor",
      date: "2026-01-22",
      amount: -5000,
      cleared: "cleared",
      import_id: "YNAB:-5000:2026-01-22:1",
    },
    phantom: {
      id: "phantom",
      date: "2026-01-22",
      amount: 5000,
      cleared: "uncleared",
    },
    anchorAccount: checking,
    phantomAccount: credit,
  });

  const orphan = tx({
    id: "orphan",
    date: "2026-01-23",
    amount: 5000,
    cleared: "cleared",
    account_id: credit2.id,
    account_name: credit2.name,
    import_id: "YNAB:5000:2026-01-23:1",
  });

  const results = findMislinkedTransfers([checking, credit, credit2], [anchor, phantom, orphan], {
    importLagDays: IMPORT_LAG_DAYS,
  });

  expectMatch(results, { anchorId: anchor.id, phantomId: phantom.id, orphanIds: [orphan.id] });
});

test("skips when direct import is not active", () => {
  const checking = acc({
    id: "checking",
    type: "checking",
    direct_import_linked: false,
  });
  const credit = acc({ id: "credit", type: "creditCard" });
  const orphanAccount = acc({ id: "checking2", type: "checking" });

  const { anchor, phantom } = linkedTransferPair({
    anchor: {
      id: "anchor",
      date: "2026-01-22",
      amount: 6000,
      cleared: "cleared",
      import_id: "YNAB:6000:2026-01-22:1",
    },
    phantom: {
      id: "phantom",
      date: "2026-01-22",
      amount: -6000,
      cleared: "uncleared",
    },
    anchorAccount: credit,
    phantomAccount: checking,
  });

  const orphan = tx({
    id: "orphan",
    date: "2026-01-22",
    amount: -6000,
    cleared: "cleared",
    account_id: orphanAccount.id,
    account_name: orphanAccount.name,
    import_id: "YNAB:-6000:2026-01-22:1",
  });

  const results = findMislinkedTransfers(
    [checking, credit, orphanAccount],
    [anchor, phantom, orphan],
    {
      importLagDays: IMPORT_LAG_DAYS,
    },
  );
  expect(results).toHaveLength(0);
});

test("skips deleted transactions", () => {
  const scenario = buildStatusScenario({
    anchorCleared: "cleared",
    phantomCleared: "uncleared",
    orphanCleared: "cleared",
  });

  const deletedIds = [scenario.anchor.id, scenario.phantom.id, scenario.orphan.id];

  for (const deletedId of deletedIds) {
    const transactions = scenario.transactions.map((transaction) =>
      transaction.id === deletedId ? { ...transaction, deleted: true } : transaction,
    );

    const results = findMislinkedTransfers(scenario.accounts, transactions, {
      importLagDays: IMPORT_LAG_DAYS,
    });

    expect(results).toHaveLength(0);
  }
});

test("skips deleted accounts", () => {
  const scenario = buildStatusScenario({
    anchorCleared: "cleared",
    phantomCleared: "uncleared",
    orphanCleared: "cleared",
  });

  const accountIds = [
    scenario.anchor.account_id,
    scenario.phantom.account_id,
    scenario.orphan.account_id,
  ];

  for (const accountId of accountIds) {
    const accounts = scenario.accounts.map((account) =>
      account.id === accountId ? { ...account, deleted: true } : account,
    );

    const results = findMislinkedTransfers(accounts, scenario.transactions, {
      importLagDays: IMPORT_LAG_DAYS,
    });

    expect(results).toHaveLength(0);
  }
});
