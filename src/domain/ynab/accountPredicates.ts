import type { Account } from "ynab";

export function isOnBudgetOpen(account: Account | undefined): boolean {
  return Boolean(account?.on_budget && !account?.closed);
}

export function isCheckingOrSavings(account: Account | undefined): boolean {
  return Boolean(
    account &&
      (account.type === "checking" || account.type === "savings") &&
      isOnBudgetOpen(account),
  );
}

export function isCredit(account: Account | undefined): boolean {
  return Boolean(account && account.type === "creditCard" && isOnBudgetOpen(account));
}

export function isDirectImportActive(account: Account | undefined): boolean {
  return Boolean(
    account?.direct_import_linked === true && account?.direct_import_in_error !== true,
  );
}
