import { expect, test } from "bun:test";
import type { TransactionDetail } from "ynab";

import { TransactionService } from "@/domain/TransactionService";

type ClientState = {
  transaction: TransactionDetail;
  updateCalls: number;
  batchCalls: number;
};

function makeTransaction(overrides: Partial<TransactionDetail>): TransactionDetail {
  return {
    id: "t1",
    date: "2026-01-01",
    amount: -1000,
    cleared: "cleared",
    approved: true,
    account_id: "acc1",
    deleted: false,
    account_name: "Checking",
    subtransactions: [],
    ...overrides,
  };
}

function createClient(state: ClientState) {
  return {
    async getTransaction() {
      return state.transaction;
    },
    async updateTransaction(_budgetId: string, _id: string, patch: { approved?: boolean }) {
      state.updateCalls += 1;
      state.transaction = { ...state.transaction, approved: patch.approved ?? false };
      return state.transaction;
    },
    async updateTransactions(
      _budgetId: string,
      patches: Array<{ id?: string | null; approved?: boolean }>,
    ) {
      state.batchCalls += 1;
      const patch = patches[0];
      state.transaction = { ...state.transaction, approved: patch?.approved ?? false };
      return [state.transaction];
    },
  };
}

test("TransactionService skips updates when already approved", async () => {
  const state: ClientState = {
    transaction: makeTransaction({ approved: true }),
    updateCalls: 0,
    batchCalls: 0,
  };
  const client = createClient(state) as unknown as import("@/api/YnabClient").YnabClient;
  const service = new TransactionService(client, "budget");

  const results = await service.setApproved(["t1"], true);

  expect(results[0]?.status).toBe("noop");
  expect(state.updateCalls).toBe(0);
  expect(state.batchCalls).toBe(0);
});

test("TransactionService honors dry-run", async () => {
  const state: ClientState = {
    transaction: makeTransaction({ approved: false }),
    updateCalls: 0,
    batchCalls: 0,
  };
  const client = createClient(state) as unknown as import("@/api/YnabClient").YnabClient;
  const service = new TransactionService(client, "budget");

  const results = await service.setApproved(["t1"], true, { dryRun: true });

  expect(results[0]?.status).toBe("dry-run");
  expect(results[0]?.patch).toEqual({ approved: true });
  expect(state.updateCalls).toBe(0);
  expect(state.batchCalls).toBe(0);
});

test("TransactionService updates when needed", async () => {
  const state: ClientState = {
    transaction: makeTransaction({ approved: false }),
    updateCalls: 0,
    batchCalls: 0,
  };
  const client = createClient(state) as unknown as import("@/api/YnabClient").YnabClient;
  const service = new TransactionService(client, "budget");

  const results = await service.setApproved(["t1"], true);

  expect(results[0]?.status).toBe("updated");
  expect(state.updateCalls).toBe(1);
  expect(state.batchCalls).toBe(0);
  expect(results[0]?.patch).toEqual({ approved: true });
});

test("TransactionService batches updates for multiple ids", async () => {
  const state: ClientState = {
    transaction: makeTransaction({ approved: false }),
    updateCalls: 0,
    batchCalls: 0,
  };
  const client = createClient(state) as unknown as import("@/api/YnabClient").YnabClient;
  const service = new TransactionService(client, "budget");

  const results = await service.setApproved(["t1", "t2"], true);

  expect(results.map((result) => result.status)).toEqual(["updated", "updated"]);
  expect(state.updateCalls).toBe(0);
  expect(state.batchCalls).toBe(1);
});
