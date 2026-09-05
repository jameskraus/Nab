import { expect, test } from "bun:test";
import type { CategoryGroupWithCategories, SaveTransactionWithIdOrImportId } from "ynab";

import type { YnabApiClient } from "@/api/YnabClient";
import { TransactionMutationError, TransactionService } from "@/domain/TransactionService";
import { parseTransactionChanges } from "@/domain/transactionChanges";
import { tx } from "../../helpers/ynabFixtures";

const ids = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
];
const categoryId = "20000000-0000-4000-8000-000000000001";

function setup() {
  const state = new Map(ids.map((id) => [id, tx({ id, memo: "original", category_id: null })]));
  const reads: string[] = [];
  const writes: SaveTransactionWithIdOrImportId[][] = [];
  let categoryReads = 0;
  let responseMode = "normal";
  const client = {
    async listCategories() {
      categoryReads += 1;
      return [
        { name: "Everyday", categories: [{ id: categoryId, name: "Food" }] },
      ] as CategoryGroupWithCategories[];
    },
    async getTransaction(_budget: string, id: string) {
      reads.push(id);
      if (responseMode === "readback-failure" && writes.length) throw new Error("offline");
      const transaction = state.get(id);
      if (!transaction) throw new Error("Not found");
      return structuredClone(transaction);
    },
    async updateTransactions(_budget: string, patches: SaveTransactionWithIdOrImportId[]) {
      writes.push(structuredClone(patches));
      const saved = patches.map(({ id, ...patch }, index) => {
        const existing = state.get(id as string);
        if (!existing) throw new Error("Not found");
        const next =
          responseMode === "partial" && index === 1
            ? existing
            : {
                ...existing,
                ...patch,
                subtransactions: existing.subtransactions,
                category_name: "API category",
                payee_name: "API payee",
              };
        state.set(existing.id, next);
        return structuredClone(next);
      });
      if (responseMode === "throw-after-save" || responseMode === "readback-failure") {
        throw new Error("connection lost");
      }
      if (responseMode === "missing") return saved.slice(0, 1);
      if (responseMode === "missing-null-field") return saved.map(({ memo, ...row }) => row);
      if (responseMode === "duplicate") return [saved[0], saved[0]];
      if (responseMode === "mismatch") return saved.map((row) => ({ ...row, memo: "stale" }));
      return saved.reverse();
    },
  } as unknown as YnabApiClient;
  return {
    service: new TransactionService(client, "test-budget"),
    state,
    reads,
    writes,
    categoryReads: () => categoryReads,
    mode: (mode: string) => {
      responseMode = mode;
    },
  };
}

test.each([
  {},
  { transactions: [] },
  { transactions: [{ id: ids[0] }] },
  { transactions: [{ id: ids[0], approved: undefined }] },
  { transactions: [{ id: "not-a-uuid", approved: true }] },
  { transactions: [{ id: ids[0], approved: "true" }] },
  { transactions: [{ id: ids[0], memo: "x".repeat(501) }] },
  { transactions: [{ id: ids[0], category_name: " " }] },
  { transactions: [{ id: ids[0], category_id: categoryId, category_name: "Food" }] },
  { transactions: [{ id: ids[0], category_id: "invalid" }] },
  { transactions: [{ id: ids[0], amount: 1000 }] },
  {
    transactions: [
      { id: ids[0], approved: true },
      { id: ids[0], memo: "other" },
    ],
  },
  { transactions: [{ id: ids[0], approved: true }], unknown: true },
])("invalid changesets fail before reads or writes: %j", async (input) => {
  const s = setup();
  await expect(s.service.applyChanges(input)).rejects.toThrow("Invalid changeset");
  expect(s.reads).toEqual([]);
  expect(s.writes).toEqual([]);
  expect(s.categoryReads()).toBe(0);
});

test("empty memo clears, false is retained, and UUID case cannot evade duplicate detection", () => {
  expect(
    parseTransactionChanges({ transactions: [{ id: ids[0], memo: "", approved: false }] }),
  ).toEqual({ transactions: [{ id: ids[0], memo: null, approved: false }] });
  const id = "abcdefab-0000-4000-8000-000000000001";
  expect(() =>
    parseTransactionChanges({
      transactions: [
        { id, approved: true },
        { id: id.toUpperCase(), approved: false },
      ],
    }),
  ).toThrow("Duplicate transaction ID");
});

test("distinct changes use one category lookup and one write, returning actual API objects in input order", async () => {
  const s = setup();
  const results = await s.service.applyChanges({
    transactions: [
      { id: ids[0], category_name: "Food", memo: "First", approved: true },
      { id: ids[1], category_name: "food", memo: null },
      { id: ids[2], approved: false },
    ],
  });
  expect(s.reads).toEqual(ids);
  expect(s.categoryReads()).toBe(1);
  expect(s.writes).toEqual([
    [
      { id: ids[0], category_id: categoryId, memo: "First", approved: true },
      { id: ids[1], category_id: categoryId, memo: null },
    ],
  ]);
  expect(results.map((result) => [result.id, result.status])).toEqual([
    [ids[0], "updated"],
    [ids[1], "updated"],
    [ids[2], "noop"],
  ]);
  expect(results[0]?.transaction?.payee_name).toBe("API payee");
  expect(results[0]?.transaction?.amount).toBe(-5000);
  expect(results[0]?.inversePatch).toEqual({
    category_id: null,
    memo: "original",
    approved: false,
  });
  expect(results[1]?.transaction?.memo).toBeNull();
});

test("dry-run exposes current state and proposed inverse, and repeated apply does no writes", async () => {
  const s = setup();
  const input = { transactions: [{ id: ids[0], memo: "changed", approved: true }] };
  const preview = await s.service.applyChanges(input, { dryRun: true });
  expect(preview[0]?.status).toBe("dry-run");
  expect(preview[0]?.transaction?.memo).toBe("original");
  expect(preview[0]?.patch).toEqual({ memo: "changed", approved: true });
  expect(preview[0]?.inversePatch).toEqual({ memo: "original", approved: false });
  expect(s.writes).toHaveLength(0);
  await s.service.applyChanges(input);
  const repeated = await s.service.applyChanges(input);
  expect(repeated[0]?.status).toBe("noop");
  expect(repeated[0]?.transaction?.memo).toBe("changed");
  expect(s.writes).toHaveLength(1);
  expect(s.categoryReads()).toBe(0);
});

test.each(["deleted", "split", "transfer-account", "transfer-link", "missing", "wrong-id"])(
  "a %s target aborts all writes even after a valid first target",
  async (kind) => {
    const s = setup();
    const row = s.state.get(ids[1]);
    if (!row) throw new Error("Fixture missing");
    if (kind === "deleted") row.deleted = true;
    if (kind === "split") row.subtransactions = [{ id: "sub" }] as typeof row.subtransactions;
    if (kind === "transfer-account") row.transfer_account_id = "other-account";
    if (kind === "transfer-link") row.transfer_transaction_id = "other-transaction";
    if (kind === "missing") s.state.delete(ids[1]);
    if (kind === "wrong-id") row.id = ids[2];
    await expect(
      s.service.applyChanges({
        transactions: [
          { id: ids[0], approved: true },
          { id: ids[1], approved: true },
        ],
      }),
    ).rejects.toThrow();
    expect(s.writes).toHaveLength(0);
  },
);

test("unresolved category names abort before transaction writes", async () => {
  const s = setup();
  await expect(
    s.service.applyChanges({ transactions: [{ id: ids[0], category_name: "Missing" }] }),
  ).rejects.toThrow("No match");
  expect(s.writes).toHaveLength(0);
});

test.each(["missing", "duplicate", "mismatch", "throw-after-save"])(
  "%s response is reconciled with reads and no write replay",
  async (mode) => {
    const s = setup();
    s.mode(mode);
    const results = await s.service.applyChanges({
      transactions: [
        { id: ids[0], memo: "first" },
        { id: ids[1], memo: "second" },
      ],
    });
    expect(results.map((result) => result.status)).toEqual(["updated", "updated"]);
    expect(s.writes).toHaveLength(1);
    expect(s.reads).toEqual(
      mode === "missing" ? [ids[0], ids[1], ids[1]] : [ids[0], ids[1], ids[0], ids[1]],
    );
  },
);

test("an omitted null field in the write response requires readback", async () => {
  const s = setup();
  s.mode("missing-null-field");
  const results = await s.service.applyChanges({ transactions: [{ id: ids[0], memo: null }] });
  expect(results[0]?.transaction?.memo).toBeNull();
  expect(s.reads).toEqual([ids[0], ids[0]]);
  expect(s.writes).toHaveLength(1);
});

test.each(["partial", "readback-failure"])(
  "%s reports per-ID evidence without false success",
  async (mode) => {
    const s = setup();
    s.mode(mode);
    let failure: unknown;
    try {
      await s.service.applyChanges({
        transactions: [
          { id: ids[0], memo: "first" },
          { id: ids[1], memo: "second" },
        ],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TransactionMutationError);
    const results = (failure as TransactionMutationError).results;
    expect(results.map((result) => result.status)).toEqual(
      mode === "partial" ? ["updated", "unverified"] : ["unverified", "unverified"],
    );
    expect(results[1]?.error).toBeDefined();
    expect(results[1]?.inversePatch).toEqual({ memo: "original" });
    expect(results[1]?.transaction?.memo).toBe(mode === "partial" ? "original" : undefined);
    expect(s.writes).toHaveLength(1);
  },
);
