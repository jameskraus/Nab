import { API } from "ynab";
import type {
  AccountsResponse,
  ApiResponse,
  BudgetSettingsResponse,
  BudgetSummaryResponse,
  CategoriesResponse,
  CategoryResponse,
  MonthDetailResponse,
  MonthSummariesResponse,
  PatchMonthCategoryWrapper,
  PatchTransactionsWrapper,
  PayeesResponse,
  PostTransactionsWrapper,
  PutTransactionWrapper,
  SaveCategoryResponse,
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
    getMonthCategoryByIdRaw: (params: {
      budgetId: string;
      month: string;
      categoryId: string;
    }) => Promise<ApiResponse<CategoryResponse>>;
    updateMonthCategory: (
      budgetId: string,
      month: string,
      categoryId: string,
      data: PatchMonthCategoryWrapper,
    ) => Promise<SaveCategoryResponse>;
  };
  months: {
    getBudgetMonthsRaw: (params: {
      budgetId: string;
    }) => Promise<ApiResponse<MonthSummariesResponse>>;
    getBudgetMonthRaw: (params: {
      budgetId: string;
      month: string;
    }) => Promise<ApiResponse<MonthDetailResponse>>;
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
    updateTransactionsRaw: (params: {
      budgetId: string;
      data: PatchTransactionsWrapper;
    }) => Promise<ApiResponse<SaveTransactionsResponse>>;
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

  get months(): YnabSdk["months"] {
    return this.api.months;
  }

  get payees(): YnabSdk["payees"] {
    return this.api.payees;
  }

  get transactions(): YnabSdk["transactions"] {
    return this.api.transactions;
  }
}
