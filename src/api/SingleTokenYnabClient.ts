import { randomUUID } from "node:crypto";

import type {
  Account,
  ApiResponse,
  BudgetSettings,
  BudgetSettingsResponse,
  BudgetSummary,
  CategoryGroupWithCategories,
  NewTransaction,
  Payee,
  PayeesResponse,
  PutTransactionWrapper,
  SaveTransactionWithIdOrImportId,
  TransactionDetail,
  TransactionResponse,
  TransactionsResponse,
} from "ynab";

import type { YnabSdk } from "./adapter";
import { YnabSdkAdapter } from "./adapter";
import { NetworkError, RateLimitedError, YnabApiError, mapYnabError } from "./errors";
type RetryConfig = {
  retries: number;
  baseMs: number;
  maxDelayMs: number;
};

export type RequestTraceEvent = {
  requestId: string;
  name: string;
  phase: "start" | "success" | "error";
  startTime?: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  status?: number;
  error?: unknown;
};

export type TransactionPatch = PutTransactionWrapper["transaction"];
export type TransactionListType = "uncategorized" | "unapproved";

export type SingleTokenYnabClientOptions = {
  api?: YnabSdk;
  maxConcurrency?: number;
  retry?: Partial<RetryConfig>;
  sleep?: (ms: number) => Promise<void>;
  trace?: (event: RequestTraceEvent) => void;
};

export interface YnabApiClient {
  listBudgets(): Promise<BudgetSummary[]>;
  getBudgetSettings(budgetId: string): Promise<BudgetSettings>;
  listAccounts(budgetId: string): Promise<Account[]>;
  listCategories(budgetId: string): Promise<CategoryGroupWithCategories[]>;
  listPayees(budgetId: string): Promise<Payee[]>;
  listTransactions(
    budgetId: string,
    sinceDate?: string,
    type?: TransactionListType,
  ): Promise<TransactionDetail[]>;
  listAccountTransactions(
    budgetId: string,
    accountId: string,
    sinceDate?: string,
    type?: TransactionListType,
  ): Promise<TransactionDetail[]>;
  getTransaction(budgetId: string, transactionId: string): Promise<TransactionDetail>;
  createTransaction(budgetId: string, transaction: NewTransaction): Promise<TransactionDetail>;
  updateTransaction(
    budgetId: string,
    transactionId: string,
    patch: TransactionPatch,
  ): Promise<TransactionDetail>;
  updateTransactions(
    budgetId: string,
    transactions: SaveTransactionWithIdOrImportId[],
  ): Promise<TransactionDetail[]>;
  deleteTransaction(budgetId: string, transactionId: string): Promise<TransactionDetail>;
}

export class SingleTokenYnabClient implements YnabApiClient {
  private readonly api: YnabSdk;
  private readonly maxConcurrency: number;
  private readonly retryConfig: RetryConfig;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly trace?: (event: RequestTraceEvent) => void;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(
    private readonly token: string,
    endpointUrl?: string,
    options?: SingleTokenYnabClientOptions,
  ) {
    this.api = options?.api ?? new YnabSdkAdapter(token, endpointUrl);
    this.maxConcurrency = options?.maxConcurrency ?? 8;
    this.retryConfig = {
      retries: options?.retry?.retries ?? 2,
      baseMs: options?.retry?.baseMs ?? 200,
      maxDelayMs: options?.retry?.maxDelayMs ?? 2000,
    };
    this.sleep =
      options?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.trace = options?.trace;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  private async withLimit<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async execute<T>(fn: () => Promise<T>): Promise<T> {
    return this.withLimit(async () => {
      try {
        return await fn();
      } catch (err) {
        throw await mapYnabError(err);
      }
    });
  }

  private async executeRaw<T>(fn: () => Promise<ApiResponse<T>>): Promise<T> {
    return this.execute(async () => {
      const response = await fn();
      return response.value();
    });
  }

  private async executeGet<T>(
    fn: () => Promise<ApiResponse<T>>,
    meta?: { retryCount?: number },
  ): Promise<T> {
    let attempt = 0;
    const { retries, baseMs, maxDelayMs } = this.retryConfig;

    while (true) {
      try {
        return await this.executeRaw(fn);
      } catch (err) {
        if (
          !(err instanceof RateLimitedError || err instanceof NetworkError) ||
          attempt >= retries
        ) {
          throw err;
        }
        const delay = Math.min(baseMs * 2 ** attempt, maxDelayMs);
        attempt += 1;
        if (meta) meta.retryCount = attempt;
        await this.sleep(delay);
      }
    }
  }

  private async traced<T>(
    name: string,
    fn: () => Promise<T>,
    meta?: Record<string, unknown>,
    summarize?: (result: T) => Record<string, unknown> | undefined,
  ): Promise<T> {
    const start = Date.now();
    const requestId = randomUUID();
    const startTime = new Date().toISOString();
    this.trace?.({ requestId, name, phase: "start", startTime, meta });
    try {
      const result = await fn();
      const summary = summarize?.(result);
      this.trace?.({
        requestId,
        name,
        phase: "success",
        startTime,
        durationMs: Date.now() - start,
        meta,
        summary,
      });
      return result;
    } catch (err) {
      const status = err instanceof YnabApiError ? err.info.status : undefined;
      this.trace?.({
        requestId,
        name,
        phase: "error",
        startTime,
        durationMs: Date.now() - start,
        meta,
        status,
        error: err,
      });
      throw err;
    }
  }

  async listBudgets(): Promise<BudgetSummary[]> {
    const meta = { retryCount: 0 };
    return this.traced(
      "listBudgets",
      async () => {
        const response = await this.executeGet(() => this.api.budgets.getBudgetsRaw({}), meta);
        return response.data.budgets;
      },
      meta,
      (budgets) => ({ count: budgets.length }),
    );
  }

  async getBudgetSettings(budgetId: string): Promise<BudgetSettings> {
    const meta = { budgetId, retryCount: 0 };
    return this.traced(
      "getBudgetSettings",
      async () => {
        const response = await this.executeGet<BudgetSettingsResponse>(
          () => this.api.budgets.getBudgetSettingsByIdRaw({ budgetId }),
          meta,
        );
        return response.data.settings;
      },
      meta,
    );
  }

  async listAccounts(budgetId: string): Promise<Account[]> {
    const meta = { budgetId, retryCount: 0 };
    return this.traced(
      "listAccounts",
      async () => {
        const response = await this.executeGet(
          () => this.api.accounts.getAccountsRaw({ budgetId }),
          meta,
        );
        return response.data.accounts;
      },
      meta,
      (accounts) => ({ count: accounts.length }),
    );
  }

  async listCategories(budgetId: string): Promise<CategoryGroupWithCategories[]> {
    const meta = { budgetId, retryCount: 0 };
    return this.traced(
      "listCategories",
      async () => {
        const response = await this.executeGet(
          () => this.api.categories.getCategoriesRaw({ budgetId }),
          meta,
        );
        return response.data.category_groups;
      },
      meta,
      (groups) => ({
        groupCount: groups.length,
        categoryCount: groups.reduce((count, group) => count + group.categories.length, 0),
      }),
    );
  }

  async listPayees(budgetId: string): Promise<Payee[]> {
    const meta = { budgetId, retryCount: 0 };
    return this.traced(
      "listPayees",
      async () => {
        const response = await this.executeGet<PayeesResponse>(
          () => this.api.payees.getPayeesRaw({ budgetId }),
          meta,
        );
        return response.data.payees;
      },
      meta,
      (payees) => ({ count: payees.length }),
    );
  }

  async listTransactions(
    budgetId: string,
    sinceDate?: string,
    type?: TransactionListType,
  ): Promise<TransactionDetail[]> {
    const meta = { budgetId, sinceDate, type, retryCount: 0 };
    return this.traced(
      "listTransactions",
      async () => {
        const response = await this.executeGet<TransactionsResponse>(
          () =>
            this.api.transactions.getTransactionsRaw({
              budgetId,
              sinceDate,
              type,
            }),
          meta,
        );
        return response.data.transactions;
      },
      meta,
      (transactions) => ({ count: transactions.length }),
    );
  }

  async listAccountTransactions(
    budgetId: string,
    accountId: string,
    sinceDate?: string,
    type?: TransactionListType,
  ): Promise<TransactionDetail[]> {
    const meta = { budgetId, accountId, sinceDate, type, retryCount: 0 };
    return this.traced(
      "listAccountTransactions",
      async () => {
        const response = await this.executeGet<TransactionsResponse>(
          () =>
            this.api.transactions.getTransactionsByAccountRaw({
              budgetId,
              accountId,
              sinceDate,
              type,
            }),
          meta,
        );
        return response.data.transactions;
      },
      meta,
      (transactions) => ({ count: transactions.length }),
    );
  }

  async getTransaction(budgetId: string, transactionId: string): Promise<TransactionDetail> {
    const meta = { budgetId, transactionId, retryCount: 0 };
    return this.traced(
      "getTransaction",
      async () => {
        const response = await this.executeGet<TransactionResponse>(
          () => this.api.transactions.getTransactionByIdRaw({ budgetId, transactionId }),
          meta,
        );
        return response.data.transaction;
      },
      meta,
      () => ({ found: true }),
    );
  }

  async createTransaction(
    budgetId: string,
    transaction: NewTransaction,
  ): Promise<TransactionDetail> {
    const meta = { budgetId };
    return this.traced(
      "createTransaction",
      async () => {
        const response = await this.execute(() =>
          this.api.transactions.createTransaction(budgetId, { transaction }),
        );
        const created = response.data.transaction ?? response.data.transactions?.[0];
        if (!created) {
          throw new Error("YNAB did not return a created transaction.");
        }
        return created;
      },
      meta,
      (created) => ({ id: created.id }),
    );
  }

  async updateTransaction(
    budgetId: string,
    transactionId: string,
    patch: TransactionPatch,
  ): Promise<TransactionDetail> {
    const meta = { budgetId, transactionId };
    return this.traced(
      "updateTransaction",
      async () => {
        const response = await this.execute(() =>
          this.api.transactions.updateTransaction(budgetId, transactionId, { transaction: patch }),
        );
        return response.data.transaction;
      },
      meta,
      (updated) => ({ id: updated.id }),
    );
  }

  async updateTransactions(
    budgetId: string,
    transactions: SaveTransactionWithIdOrImportId[],
  ): Promise<TransactionDetail[]> {
    const meta = { budgetId, count: transactions.length };
    return this.traced(
      "updateTransactions",
      async () => {
        const response = await this.execute(() =>
          this.api.transactions.updateTransactions(budgetId, { transactions }),
        );
        return response.data.transactions ?? [];
      },
      meta,
      (updated) => ({ count: updated.length }),
    );
  }

  async deleteTransaction(budgetId: string, transactionId: string): Promise<TransactionDetail> {
    const meta = { budgetId, transactionId };
    return this.traced(
      "deleteTransaction",
      async () => {
        const response = await this.execute(() =>
          this.api.transactions.deleteTransaction(budgetId, transactionId),
        );
        return response.data.transaction;
      },
      meta,
      (deleted) => ({ id: deleted.id }),
    );
  }
}
