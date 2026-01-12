import { API } from "ynab";
import type {
  AccountsResponse,
  ApiResponse,
  BudgetSettingsResponse,
  BudgetSummaryResponse,
  CategoriesResponse,
  PatchTransactionsWrapper,
  PayeesResponse,
  PostTransactionsWrapper,
  PutTransactionWrapper,
  SaveTransactionsResponse,
  TransactionResponse,
  TransactionsResponse,
} from "ynab";

export type YnabSdk = {
  budgets: {
    getBudgetsRaw: (params: { includeAccounts?: boolean }) => Promise<
      ApiResponse<BudgetSummaryResponse>
    >;
    getBudgetSettingsByIdRaw: (params: { budgetId: string }) => Promise<
      ApiResponse<BudgetSettingsResponse>
    >;
  };
  accounts: {
    getAccountsRaw: (params: { budgetId: string }) => Promise<ApiResponse<AccountsResponse>>;
  };
  categories: {
    getCategoriesRaw: (params: { budgetId: string }) => Promise<ApiResponse<CategoriesResponse>>;
  };
  payees: {
    getPayeesRaw: (params: { budgetId: string }) => Promise<ApiResponse<PayeesResponse>>;
  };
  transactions: {
    getTransactionsRaw: (params: {
      budgetId: string;
      sinceDate?: string;
      type?: "uncategorized" | "unapproved";
      lastKnowledgeOfServer?: number;
    }) => Promise<ApiResponse<TransactionsResponse>>;
    getTransactionsByAccountRaw: (params: {
      budgetId: string;
      accountId: string;
      sinceDate?: string;
      type?: "uncategorized" | "unapproved";
      lastKnowledgeOfServer?: number;
    }) => Promise<ApiResponse<TransactionsResponse>>;
    getTransactionByIdRaw: (params: {
      budgetId: string;
      transactionId: string;
    }) => Promise<ApiResponse<TransactionResponse>>;
    createTransaction: (
      budgetId: string,
      data: PostTransactionsWrapper,
    ) => Promise<SaveTransactionsResponse>;
    updateTransaction: (
      budgetId: string,
      transactionId: string,
      data: PutTransactionWrapper,
    ) => Promise<TransactionResponse>;
    updateTransactions: (
      budgetId: string,
      data: PatchTransactionsWrapper,
    ) => Promise<SaveTransactionsResponse>;
    deleteTransaction: (budgetId: string, transactionId: string) => Promise<TransactionResponse>;
  };
};

export class YnabSdkAdapter implements YnabSdk {
  private readonly api: API;

  constructor(token: string, endpointUrl?: string) {
    this.api = new API(token, endpointUrl);
  }

  get budgets(): YnabSdk["budgets"] {
    return this.api.budgets;
  }

  get accounts(): YnabSdk["accounts"] {
    return this.api.accounts;
  }

  get categories(): YnabSdk["categories"] {
    return this.api.categories;
  }

  get payees(): YnabSdk["payees"] {
    return this.api.payees;
  }

  get transactions(): YnabSdk["transactions"] {
    return this.api.transactions;
  }
}
