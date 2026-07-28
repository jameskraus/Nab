import { expect, test } from "bun:test";
import {
  type ApiResponse,
  type Category,
  type MonthDetail,
  type MonthSummary,
  ResponseError,
} from "ynab";

import { type RequestTraceEvent, SingleTokenYnabClient } from "@/api/SingleTokenYnabClient";
import { YnabClient } from "@/api/YnabClient";
import type { YnabApiClient } from "@/api/YnabClient";
import type { YnabSdk } from "@/api/adapter";

function apiResponse<T>(value: T): ApiResponse<T> {
  return {
    raw: new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    value: async () => value,
  };
}

function rateLimitError(): ResponseError {
  return new ResponseError(
    new Response(
      JSON.stringify({ error: { id: "429", name: "rate_limited", detail: "Rate limited" } }),
      { status: 429, headers: { "content-type": "application/json" } },
    ),
  );
}

function buildCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: "category-1",
    category_group_id: "group-1",
    category_group_name: "Bills",
    name: "Rent",
    hidden: false,
    budgeted: 100_000,
    activity: -50_000,
    balance: 50_000,
    deleted: false,
    ...overrides,
  };
}

function buildMonth(category: Category): MonthDetail {
  return {
    month: "2026-07-01",
    income: 500_000,
    budgeted: 100_000,
    activity: -50_000,
    to_be_budgeted: 400_000,
    deleted: false,
    categories: [category],
  };
}

function stubSdk(overrides: {
  categories?: Partial<YnabSdk["categories"]>;
  months?: Partial<YnabSdk["months"]>;
}): YnabSdk {
  const notImplemented = async (): Promise<never> => {
    throw new Error("Not implemented");
  };
  return {
    budgets: {
      getBudgetsRaw: notImplemented,
      getBudgetSettingsByIdRaw: notImplemented,
    },
    accounts: {
      getAccountsRaw: notImplemented,
    },
    categories: {
      getCategoriesRaw: notImplemented,
      getMonthCategoryByIdRaw: notImplemented,
      updateMonthCategory: notImplemented,
      ...overrides.categories,
    },
    months: {
      getBudgetMonthsRaw: notImplemented,
      getBudgetMonthRaw: notImplemented,
      ...overrides.months,
    },
    payees: {
      getPayeesRaw: notImplemented,
    },
    transactions: {
      getTransactionsRaw: notImplemented,
      getTransactionsByAccountRaw: notImplemented,
      getTransactionByIdRaw: notImplemented,
      createTransaction: notImplemented,
      updateTransaction: notImplemented,
      updateTransactions: notImplemented,
      deleteTransaction: notImplemented,
    },
  };
}

test("SingleTokenYnabClient reads a budget month and month category through raw SDK calls", async () => {
  const category = buildCategory();
  const budgetMonth = buildMonth(category);
  const { categories: _categories, ...budgetMonthSummary } = budgetMonth;
  const calls: Array<{ name: string; params: unknown }> = [];
  const traces: RequestTraceEvent[] = [];
  const api = stubSdk({
    months: {
      getBudgetMonthsRaw: async (params) => {
        calls.push({ name: "months", params });
        return apiResponse({ data: { months: [budgetMonthSummary], server_knowledge: 42 } });
      },
      getBudgetMonthRaw: async (params) => {
        calls.push({ name: "month", params });
        return apiResponse({ data: { month: budgetMonth } });
      },
    },
    categories: {
      getMonthCategoryByIdRaw: async (params) => {
        calls.push({ name: "category", params });
        return apiResponse({ data: { category } });
      },
    },
  });
  const client = new SingleTokenYnabClient("token", undefined, {
    api,
    trace: (event) => traces.push(event),
  });

  expect(await client.listBudgetMonths("budget-1")).toEqual([budgetMonthSummary]);
  expect(await client.getBudgetMonth("budget-1", "2026-07-01")).toEqual(budgetMonth);
  expect(await client.getMonthCategory("budget-1", "2026-07-01", "category-1")).toEqual(category);
  expect(calls).toEqual([
    {
      name: "months",
      params: { budgetId: "budget-1" },
    },
    {
      name: "month",
      params: { budgetId: "budget-1", month: "2026-07-01" },
    },
    {
      name: "category",
      params: {
        budgetId: "budget-1",
        month: "2026-07-01",
        categoryId: "category-1",
      },
    },
  ]);
  expect(
    traces
      .filter((event) => event.phase === "success")
      .map(({ name, meta, summary }) => ({ name, meta, summary })),
  ).toEqual([
    {
      name: "listBudgetMonths",
      meta: { budgetId: "budget-1", retryCount: 0 },
      summary: { count: 1 },
    },
    {
      name: "getBudgetMonth",
      meta: { budgetId: "budget-1", month: "2026-07-01", retryCount: 0 },
      summary: { categoryCount: 1 },
    },
    {
      name: "getMonthCategory",
      meta: {
        budgetId: "budget-1",
        month: "2026-07-01",
        categoryId: "category-1",
        retryCount: 0,
      },
      summary: { found: true },
    },
  ]);
});

test("SingleTokenYnabClient updates only the month category budgeted amount", async () => {
  const updated = buildCategory({ budgeted: 250_000, balance: 200_000 });
  let received:
    | {
        budgetId: string;
        month: string;
        categoryId: string;
        data: { category: { budgeted: number } };
      }
    | undefined;
  const api = stubSdk({
    categories: {
      updateMonthCategory: async (budgetId, month, categoryId, data) => {
        received = { budgetId, month, categoryId, data };
        return { data: { category: updated, server_knowledge: 42 } };
      },
    },
  });
  const traces: RequestTraceEvent[] = [];
  const client = new SingleTokenYnabClient("token", undefined, {
    api,
    trace: (event) => traces.push(event),
  });

  expect(await client.updateMonthCategory("budget-1", "2026-07-01", "category-1", 250_000)).toEqual(
    updated,
  );
  expect(received).toEqual({
    budgetId: "budget-1",
    month: "2026-07-01",
    categoryId: "category-1",
    data: { category: { budgeted: 250_000 } },
  });
  expect(
    traces
      .filter((event) => event.phase === "success")
      .map(({ name, meta, summary }) => ({ name, meta, summary })),
  ).toEqual([
    {
      name: "updateMonthCategory",
      meta: {
        budgetId: "budget-1",
        month: "2026-07-01",
        categoryId: "category-1",
        budgetedMilliunits: 250_000,
      },
      summary: { id: "category-1", budgeted: 250_000 },
    },
  ]);
});

test("budget-month reads preserve current category fields omitted by the pinned SDK decoder", async () => {
  const rawCategory = {
    ...buildCategory(),
    internal: true,
    goal_target_date: "2026-12-31",
  };
  const rawMonth = buildMonth(rawCategory);
  const decodedMonth = buildMonth(buildCategory());
  const api = stubSdk({
    months: {
      getBudgetMonthRaw: async () => ({
        raw: new Response(JSON.stringify({ data: { month: rawMonth } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        value: async () => ({ data: { month: decodedMonth } }),
      }),
    },
  });
  const client = new SingleTokenYnabClient("token", undefined, { api });

  const month = await client.getBudgetMonth("budget-1", "2026-07-01");
  const category = month.categories[0] as Category & {
    internal?: boolean;
    goal_target_date?: string | null;
  };
  expect(category.internal).toBe(true);
  expect(category.goal_target_date).toBe("2026-12-31");
});

test("month/category reads retry, while month category updates do not", async () => {
  const category = buildCategory();
  const budgetMonth = buildMonth(category);
  let readCalls = 0;
  let updateCalls = 0;
  const api = stubSdk({
    months: {
      getBudgetMonthRaw: async () => {
        readCalls += 1;
        if (readCalls === 1) throw rateLimitError();
        return apiResponse({ data: { month: budgetMonth } });
      },
    },
    categories: {
      updateMonthCategory: async () => {
        updateCalls += 1;
        throw rateLimitError();
      },
    },
  });
  const client = new SingleTokenYnabClient("token", undefined, {
    api,
    retry: { retries: 1, baseMs: 1, maxDelayMs: 1 },
    sleep: async () => {},
  });

  expect(await client.getBudgetMonth("budget-1", "2026-07-01")).toEqual(budgetMonth);
  expect(readCalls).toBe(2);
  await expect(
    client.updateMonthCategory("budget-1", "2026-07-01", "category-1", 250_000),
  ).rejects.toBeTruthy();
  expect(updateCalls).toBe(1);
});

test("YnabClient delegates month/category reads and updates through token rotation", async () => {
  const category = buildCategory({ budgeted: 300_000 });
  const budgetMonth = buildMonth(category);
  const { categories: _categories, ...budgetMonthSummary } = budgetMonth;
  const budgetMonths: MonthSummary[] = [budgetMonthSummary];
  const calls: unknown[][] = [];
  const delegated = {
    listBudgetMonths: async (...args: unknown[]) => {
      calls.push(["listBudgetMonths", ...args]);
      return budgetMonths;
    },
    getBudgetMonth: async (...args: unknown[]) => {
      calls.push(["getBudgetMonth", ...args]);
      return budgetMonth;
    },
    getMonthCategory: async (...args: unknown[]) => {
      calls.push(["getMonthCategory", ...args]);
      return category;
    },
    updateMonthCategory: async (...args: unknown[]) => {
      calls.push(["updateMonthCategory", ...args]);
      return category;
    },
  } as unknown as YnabApiClient;
  const client = new YnabClient(["token"], undefined, {
    clientFactory: () => delegated,
  });

  expect(await client.listBudgetMonths("budget-1")).toEqual(budgetMonths);
  expect(await client.getBudgetMonth("budget-1", "2026-07-01")).toEqual(budgetMonth);
  expect(await client.getMonthCategory("budget-1", "2026-07-01", "category-1")).toEqual(category);
  expect(await client.updateMonthCategory("budget-1", "2026-07-01", "category-1", 300_000)).toEqual(
    category,
  );
  expect(calls).toEqual([
    ["listBudgetMonths", "budget-1"],
    ["getBudgetMonth", "budget-1", "2026-07-01"],
    ["getMonthCategory", "budget-1", "2026-07-01", "category-1"],
    ["updateMonthCategory", "budget-1", "2026-07-01", "category-1", 300_000],
  ]);
});
