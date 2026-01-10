import type { CommandModule } from "yargs";
import type { Account, CurrencyFormat } from "ynab";

import type { AppContext } from "@/app/createAppContext";
import type { CliGlobalArgs } from "@/cli/types";
import { resolveBudgetCurrencyFormat } from "@/domain/budgetCurrency";
import {
  type OutputWriterOptions,
  createOutputWriter,
  fieldColumn,
  formatCurrency,
  parseOutputFormat,
} from "@/io";

type AccountListRow = {
  id: string;
  name: string;
  type: string;
  onBudget: boolean;
  closed: boolean;
  balance: string;
};

type CliArgs = CliGlobalArgs & { appContext?: AppContext };

type AccountOutput = Omit<
  Account,
  "balance" | "cleared_balance" | "uncleared_balance" | "debt_original_balance"
> & {
  balance: string;
  balance_display: string;
  raw_balance: number;
  cleared_balance: string;
  cleared_balance_display: string;
  raw_cleared_balance: number;
  uncleared_balance: string;
  uncleared_balance_display: string;
  raw_uncleared_balance: number;
  debt_original_balance?: string | null;
  debt_original_balance_display?: string | null;
  raw_debt_original_balance?: number | null;
};

type MoneyWriterOptions = OutputWriterOptions & { currencyFormat?: CurrencyFormat | null };

function formatDebtOriginalBalance(
  value: number | null | undefined,
  currencyFormat?: CurrencyFormat | null,
): Pick<
  AccountOutput,
  "debt_original_balance" | "debt_original_balance_display" | "raw_debt_original_balance"
> {
  if (value === undefined) return {};
  if (value === null) {
    return {
      debt_original_balance: null,
      debt_original_balance_display: null,
      raw_debt_original_balance: null,
    };
  }
  const display = formatCurrency(value, currencyFormat);
  return {
    debt_original_balance: display,
    debt_original_balance_display: display,
    raw_debt_original_balance: value,
  };
}

function accountRows(
  accounts: Account[],
  currencyFormat?: CurrencyFormat | null,
): AccountListRow[] {
  return accounts.map((account) => ({
    id: account.id,
    name: account.name,
    type: account.type,
    onBudget: account.on_budget,
    closed: account.closed,
    balance: formatCurrency(account.balance, currencyFormat),
  }));
}

export function writeAccountList(
  accounts: Account[],
  rawFormat?: string,
  options?: MoneyWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");
  const { currencyFormat, ...writerOptions } = options ?? {};

  if (format === "json") {
    const decorated: AccountOutput[] = accounts.map((account) => {
      const { balance, cleared_balance, uncleared_balance, debt_original_balance, ...rest } =
        account;
      const balanceDisplay = formatCurrency(balance, currencyFormat);
      const clearedDisplay = formatCurrency(cleared_balance, currencyFormat);
      const unclearedDisplay = formatCurrency(uncleared_balance, currencyFormat);
      return {
        ...rest,
        balance: balanceDisplay,
        balance_display: balanceDisplay,
        raw_balance: balance,
        cleared_balance: clearedDisplay,
        cleared_balance_display: clearedDisplay,
        raw_cleared_balance: cleared_balance,
        uncleared_balance: unclearedDisplay,
        uncleared_balance_display: unclearedDisplay,
        raw_uncleared_balance: uncleared_balance,
        ...formatDebtOriginalBalance(debt_original_balance, currencyFormat),
      };
    });
    createOutputWriter("json", writerOptions).write(decorated);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", writerOptions).write(accounts.map((account) => account.id));
    return;
  }

  const rows = accountRows(accounts, currencyFormat);

  if (format === "tsv") {
    createOutputWriter("tsv", writerOptions).write(rows);
    return;
  }

  createOutputWriter("table", writerOptions).write({
    columns: [
      fieldColumn("name", { header: "Name" }),
      fieldColumn("id", { header: "Id" }),
      fieldColumn("type", { header: "Type" }),
      fieldColumn("onBudget", { header: "On Budget" }),
      fieldColumn("closed", { header: "Closed" }),
      fieldColumn("balance", { header: "Balance", align: "right" }),
    ],
    rows,
  });
}

export const accountCommand: CommandModule<CliGlobalArgs> = {
  command: "account <command>",
  describe: "Accounts",
  builder: (y) =>
    y
      .command({
        command: "list",
        describe: "List accounts for the effective budget",
        handler: async (argv) => {
          const { appContext, format } = argv as unknown as CliArgs;
          const ctx = appContext;
          if (!ctx?.ynab || !ctx.budgetId) {
            throw new Error("Missing budget context for account list.");
          }
          const accounts = await ctx.ynab.listAccounts(ctx.budgetId);
          const currencyFormat = await resolveBudgetCurrencyFormat(ctx, ctx.budgetId);
          writeAccountList(accounts, format, { currencyFormat });
        },
      })
      .demandCommand(1, "Specify an account subcommand")
      .strict(),
  handler: () => {},
};
