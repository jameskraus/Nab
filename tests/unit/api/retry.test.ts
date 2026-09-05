import { expect, test } from "bun:test";
import { ResponseError } from "ynab";

import { SingleTokenYnabClient } from "@/api/SingleTokenYnabClient";
import type { YnabSdk } from "@/api/adapter";
import { tx } from "../../helpers/ynabFixtures";

type ApiOverrides = {
  budgets?: Partial<YnabSdk["budgets"]>;
  accounts?: Partial<YnabSdk["accounts"]>;
  categories?: Partial<YnabSdk["categories"]>;
  months?: Partial<YnabSdk["months"]>;
  payees?: Partial<YnabSdk["payees"]>;
  transactions?: Partial<YnabSdk["transactions"]>;
};

const stubSdk = (overrides: ApiOverrides): YnabSdk => ({
  budgets: {
    getBudgetsRaw: async () => {
      throw new Error("Not implemented");
    },
    getBudgetSettingsByIdRaw: async () => {
      throw new Error("Not implemented");
    },
    ...overrides.budgets,
  },
  accounts: {
    getAccountsRaw: async () => {
      throw new Error("Not implemented");
    },
    ...overrides.accounts,
  },
  categories: {
    getCategoriesRaw: async () => {
      throw new Error("Not implemented");
    },
    getMonthCategoryByIdRaw: async () => {
      throw new Error("Not implemented");
    },
    updateMonthCategory: async () => {
      throw new Error("Not implemented");
    },
    ...overrides.categories,
  },
  months: {
    getBudgetMonthsRaw: async () => {
      throw new Error("Not implemented");
    },
    getBudgetMonthRaw: async () => {
      throw new Error("Not implemented");
    },
    ...overrides.months,
  },
  payees: {
    getPayeesRaw: async () => {
      throw new Error("Not implemented");
    },
    ...overrides.payees,
  },
  transactions: {
    getTransactionsRaw: async () => {
      throw new Error("Not implemented");
    },
    getTransactionsByAccountRaw: async () => {
      throw new Error("Not implemented");
    },
    getTransactionByIdRaw: async () => {
      throw new Error("Not implemented");
    },
    createTransaction: async () => {
      throw new Error("Not implemented");
    },
    updateTransaction: async () => {
      throw new Error("Not implemented");
    },
    updateTransactionsRaw: async () => {
      throw new Error("Not implemented");
    },
    deleteTransaction: async () => {
      throw new Error("Not implemented");
    },
    ...overrides.transactions,
  },
});

function rateLimitError() {
  const response = new Response(
    JSON.stringify({ error: { id: "429", name: "rate_limited", detail: "Rate limited" } }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
  return new ResponseError(response);
}

test("SingleTokenYnabClient retries GET on 429", async () => {
  let calls = 0;
  const api = stubSdk({
    budgets: {
      getBudgetsRaw: async () => {
        calls += 1;
        if (calls === 1) throw rateLimitError();
        return {
          raw: new Response(JSON.stringify({ data: { budgets: [] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
          value: async () => ({ data: { budgets: [] } }),
        };
      },
    },
  });

  const client = new SingleTokenYnabClient("token", undefined, {
    api,
    retry: { retries: 1, baseMs: 1, maxDelayMs: 1 },
    sleep: async () => {},
  });

  const budgets = await client.listBudgets();
  expect(budgets).toEqual([]);
  expect(calls).toBe(2);
});

test("SingleTokenYnabClient does not retry mutations", async () => {
  let calls = 0;
  const api = stubSdk({
    transactions: {
      updateTransaction: async () => {
        calls += 1;
        throw rateLimitError();
      },
    },
  });

  const client = new SingleTokenYnabClient("token", undefined, {
    api,
    retry: { retries: 2, baseMs: 1, maxDelayMs: 1 },
    sleep: async () => {},
  });

  await expect(
    client.updateTransaction("budget", "tx", { account_id: "acc" }),
  ).rejects.toBeTruthy();
  expect(calls).toBe(1);
});

test("bulk updates preserve null and current API fields without SDK model conversion", async () => {
  const transaction = {
    ...tx({ id: "tx", memo: null, category_id: null }),
    current_api_field: "kept",
  };
  const api = stubSdk({
    transactions: {
      updateTransactionsRaw: async (params) => {
        expect(params).toEqual({
          budgetId: "budget",
          data: { transactions: [{ id: "tx", memo: null }] },
        });
        return {
          raw: Response.json({ data: { transactions: [transaction] } }),
          value: async () => {
            throw new Error("Lossy SDK conversion must not be used");
          },
        };
      },
    },
  });
  const client = new SingleTokenYnabClient("token", undefined, { api });
  expect(await client.updateTransactions("budget", [{ id: "tx", memo: null }])).toEqual([
    transaction,
  ]);
});

test("bulk updates do not retry an interrupted response", async () => {
  let calls = 0;
  const api = stubSdk({
    transactions: {
      updateTransactionsRaw: async () => {
        calls += 1;
        throw new Error("connection interrupted");
      },
    },
  });
  const client = new SingleTokenYnabClient("token", undefined, { api, retry: { retries: 2 } });
  await expect(client.updateTransactions("budget", [{ id: "tx", memo: null }])).rejects.toThrow();
  expect(calls).toBe(1);
});
