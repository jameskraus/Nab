import type { Account, TransactionDetail } from "ynab";

export function acc(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    name: "Account",
    type: "checking",
    on_budget: true,
    closed: false,
    balance: 0,
    cleared_balance: 0,
    uncleared_balance: 0,
    transfer_payee_id: null,
    deleted: false,
    direct_import_linked: true,
    direct_import_in_error: false,
    ...overrides,
  };
}

export function tx(overrides: Partial<TransactionDetail> = {}): TransactionDetail {
  return {
    id: "tx-1",
    date: "2026-01-22",
    amount: -5000,
    cleared: "cleared",
    approved: false,
    account_id: "acc-1",
    account_name: "Account",
    deleted: false,
    subtransactions: [],
    import_id: null,
    transfer_account_id: null,
    transfer_transaction_id: null,
    ...overrides,
  };
}

export function linkedTransferPair(options: {
  anchor: Partial<TransactionDetail>;
  phantom: Partial<TransactionDetail>;
  anchorAccount: Account;
  phantomAccount: Account;
}): { anchor: TransactionDetail; phantom: TransactionDetail } {
  const anchorId = options.anchor.id ?? "anchor";
  const phantomId = options.phantom.id ?? "phantom";

  const anchor = tx({
    ...options.anchor,
    id: anchorId,
    account_id: options.anchorAccount.id,
    account_name: options.anchorAccount.name,
    transfer_account_id: options.phantomAccount.id,
    transfer_transaction_id: phantomId,
  });

  const phantom = tx({
    ...options.phantom,
    id: phantomId,
    account_id: options.phantomAccount.id,
    account_name: options.phantomAccount.name,
    transfer_account_id: options.anchorAccount.id,
    transfer_transaction_id: anchorId,
  });

  return { anchor, phantom };
}

export function sortIds(ids: string[]): string[] {
  return [...ids].sort();
}
