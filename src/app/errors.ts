export class MissingTokenError extends Error {
  constructor() {
    super(
      "Missing NAB_TOKENS. Set it via `nab config set --tokens <PAT[,PAT...]>` or the NAB_TOKENS environment variable. Create tokens at https://app.ynab.com/settings/developer.",
    );
    this.name = "MissingTokenError";
  }
}

export class MissingBudgetIdError extends Error {
  constructor() {
    super(
      "Missing NAB_BUDGET_ID. Set it via `nab config set --budget-id <ID>`, the NAB_BUDGET_ID environment variable, or --budget-id.",
    );
    this.name = "MissingBudgetIdError";
  }
}
