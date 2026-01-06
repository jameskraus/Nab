import type {
  Account,
  BudgetSummary,
  CategoryGroupWithCategories,
  NewTransaction,
  Payee,
  SaveTransactionWithIdOrImportId,
  TransactionDetail,
} from "ynab";

import type {
  SingleTokenYnabClientOptions,
  TransactionPatch,
  YnabApiClient,
} from "./SingleTokenYnabClient";
import { SingleTokenYnabClient } from "./SingleTokenYnabClient";
import { RateLimitedError, UnauthorizedError } from "./errors";

export type {
  RequestTraceEvent,
  SingleTokenYnabClientOptions,
  TransactionPatch,
  YnabApiClient,
} from "./SingleTokenYnabClient";
export { SingleTokenYnabClient } from "./SingleTokenYnabClient";

export type TokenTraceEvent = {
  token: string;
  action: "select" | "cooldown" | "disable" | "skip";
  reason?: string;
};

type TokenEntry = {
  token: string;
  client: YnabApiClient;
  disabled: boolean;
  cooldownUntil?: number;
};

export type YnabClientOptions = SingleTokenYnabClientOptions & {
  cooldownMs?: number;
  failFast?: boolean;
  clientFactory?: (token: string, options: SingleTokenYnabClientOptions) => YnabApiClient;
  tokenTrace?: (event: TokenTraceEvent) => void;
};

const DEFAULT_COOLDOWN_MS = 60_000;

function redactToken(token: string): string {
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export class YnabClient implements YnabApiClient {
  private readonly entries: TokenEntry[];
  private readonly cooldownMs: number;
  private readonly failFast: boolean;
  private readonly tokenTrace?: (event: TokenTraceEvent) => void;
  private cursor = 0;

  constructor(tokens: string[], endpointUrl?: string, options: YnabClientOptions = {}) {
    const { cooldownMs, failFast, clientFactory, tokenTrace, ...ynabOptions } = options;
    const retry = { ...ynabOptions.retry, retries: 0 };
    const clientOptions: SingleTokenYnabClientOptions = { ...ynabOptions, retry };
    const createClient =
      clientFactory ??
      ((token: string, opts: SingleTokenYnabClientOptions) =>
        new SingleTokenYnabClient(token, endpointUrl, opts));
    this.entries = tokens.map((token) => ({
      token,
      client: createClient(token, clientOptions),
      disabled: false,
    }));
    this.cooldownMs = cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.failFast = failFast ?? true;
    this.tokenTrace = tokenTrace;
  }

  private isCooling(entry: TokenEntry): boolean {
    return entry.cooldownUntil !== undefined && entry.cooldownUntil > Date.now();
  }

  private nextIndex(): number | null {
    if (this.entries.length === 0) return null;
    const start = this.cursor % this.entries.length;
    for (let offset = 0; offset < this.entries.length; offset += 1) {
      const idx = (start + offset) % this.entries.length;
      const entry = this.entries[idx];
      if (!entry) continue;
      if (entry.disabled) {
        this.tokenTrace?.({ token: redactToken(entry.token), action: "skip", reason: "disabled" });
        continue;
      }
      if (this.isCooling(entry)) {
        this.tokenTrace?.({ token: redactToken(entry.token), action: "skip", reason: "cooldown" });
        continue;
      }
      return idx;
    }
    return null;
  }

  private markRateLimited(entry: TokenEntry, err: RateLimitedError): void {
    entry.cooldownUntil = Date.now() + this.cooldownMs;
    this.tokenTrace?.({
      token: redactToken(entry.token),
      action: "cooldown",
      reason: "rate_limited",
    });
  }

  private allTokensRateLimitedError(): RateLimitedError {
    return new RateLimitedError({
      detail:
        "All configured YNAB access tokens are rate limited. Create more tokens at https://app.ynab.com/settings/developer and set NAB_TOKENS.",
    });
  }

  private allTokensUnauthorizedError(): UnauthorizedError {
    return new UnauthorizedError({
      detail:
        "All configured YNAB access tokens are unauthorized. Create or refresh tokens at https://app.ynab.com/settings/developer and set NAB_TOKENS.",
    });
  }

  private async execute<T>(fn: (client: YnabApiClient) => Promise<T>): Promise<T> {
    let attempts = 0;

    while (attempts < this.entries.length) {
      const idx = this.nextIndex();
      if (idx === null) break;

      const entry = this.entries[idx];
      this.cursor = (idx + 1) % this.entries.length;
      attempts += 1;
      this.tokenTrace?.({ token: redactToken(entry.token), action: "select" });

      try {
        return await fn(entry.client);
      } catch (err) {
        if (err instanceof RateLimitedError) {
          this.markRateLimited(entry, err);
          continue;
        }
        if (err instanceof UnauthorizedError) {
          entry.disabled = true;
          this.tokenTrace?.({
            token: redactToken(entry.token),
            action: "disable",
            reason: "unauthorized",
          });
          continue;
        }
        throw err;
      }
    }

    const enabled = this.entries.filter((entry) => !entry.disabled);
    if (enabled.length === 0) {
      throw this.allTokensUnauthorizedError();
    }
    if (this.failFast) {
      throw this.allTokensRateLimitedError();
    }
    throw this.allTokensRateLimitedError();
  }

  async listBudgets(): Promise<BudgetSummary[]> {
    return this.execute((client) => client.listBudgets());
  }

  async listAccounts(budgetId: string): Promise<Account[]> {
    return this.execute((client) => client.listAccounts(budgetId));
  }

  async listCategories(budgetId: string): Promise<CategoryGroupWithCategories[]> {
    return this.execute((client) => client.listCategories(budgetId));
  }

  async listPayees(budgetId: string): Promise<Payee[]> {
    return this.execute((client) => client.listPayees(budgetId));
  }

  async listTransactions(budgetId: string, sinceDate?: string): Promise<TransactionDetail[]> {
    return this.execute((client) => client.listTransactions(budgetId, sinceDate));
  }

  async getTransaction(budgetId: string, transactionId: string): Promise<TransactionDetail> {
    return this.execute((client) => client.getTransaction(budgetId, transactionId));
  }

  async createTransaction(
    budgetId: string,
    transaction: NewTransaction,
  ): Promise<TransactionDetail> {
    return this.execute((client) => client.createTransaction(budgetId, transaction));
  }

  async updateTransaction(
    budgetId: string,
    transactionId: string,
    patch: TransactionPatch,
  ): Promise<TransactionDetail> {
    return this.execute((client) => client.updateTransaction(budgetId, transactionId, patch));
  }

  async updateTransactions(
    budgetId: string,
    transactions: SaveTransactionWithIdOrImportId[],
  ): Promise<TransactionDetail[]> {
    return this.execute((client) => client.updateTransactions(budgetId, transactions));
  }

  async deleteTransaction(budgetId: string, transactionId: string): Promise<TransactionDetail> {
    return this.execute((client) => client.deleteTransaction(budgetId, transactionId));
  }

  getTokenSummary(): string[] {
    return this.entries.map((entry) => redactToken(entry.token));
  }
}
