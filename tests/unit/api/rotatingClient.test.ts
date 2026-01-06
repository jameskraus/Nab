import { expect, test } from "bun:test";

import type { BudgetSummary } from "ynab";

import { YnabClient } from "@/api/YnabClient";
import type { YnabApiClient } from "@/api/YnabClient";
import { RateLimitedError, UnauthorizedError } from "@/api/errors";

class StubClient implements YnabApiClient {
  constructor(private readonly handler: (client: StubClient) => Promise<BudgetSummary[]>) {}

  async listBudgets(): Promise<BudgetSummary[]> {
    return this.handler(this);
  }

  async listAccounts(): Promise<never> {
    throw new Error("not implemented");
  }

  async listCategories(): Promise<never> {
    throw new Error("not implemented");
  }

  async listPayees(): Promise<never> {
    throw new Error("not implemented");
  }

  async listTransactions(): Promise<never> {
    throw new Error("not implemented");
  }

  async getTransaction(): Promise<never> {
    throw new Error("not implemented");
  }

  async createTransaction(): Promise<never> {
    throw new Error("not implemented");
  }

  async updateTransaction(): Promise<never> {
    throw new Error("not implemented");
  }

  async updateTransactions(): Promise<never> {
    throw new Error("not implemented");
  }

  async deleteTransaction(): Promise<never> {
    throw new Error("not implemented");
  }
}

test("YnabClient: rotates on rate limit", async () => {
  const calls: string[] = [];
  const client = new YnabClient(["t1", "t2"], undefined, {
    clientFactory: (token) => {
      if (token === "t1") {
        return new StubClient(async () => {
          calls.push("t1");
          throw new RateLimitedError({ detail: "too_many_requests" });
        });
      }
      return new StubClient(async () => {
        calls.push("t2");
        return [{ id: "b1", name: "Budget", last_modified_on: "" }];
      });
    },
  });

  const budgets = await client.listBudgets();
  expect(budgets).toHaveLength(1);
  expect(calls).toEqual(["t1", "t2"]);
});

test("YnabClient: disables unauthorized tokens", async () => {
  const calls: string[] = [];
  const client = new YnabClient(["bad", "good"], undefined, {
    clientFactory: (token) => {
      if (token === "bad") {
        return new StubClient(async () => {
          calls.push("bad");
          throw new UnauthorizedError({ detail: "unauthorized" });
        });
      }
      return new StubClient(async () => {
        calls.push("good");
        return [{ id: "b1", name: "Budget", last_modified_on: "" }];
      });
    },
  });

  const budgets = await client.listBudgets();
  expect(budgets).toHaveLength(1);
  expect(calls).toEqual(["bad", "good"]);
});

test("YnabClient: fails fast when all tokens are rate limited", async () => {
  const client = new YnabClient(["t1", "t2"], undefined, {
    clientFactory: () =>
      new StubClient(async () => {
        throw new RateLimitedError({ detail: "too_many_requests" });
      }),
  });

  await expect(client.listBudgets()).rejects.toThrow(
    /Create more tokens at https:\/\/app\.ynab\.com\/settings\/developer/,
  );
});
