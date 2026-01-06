import type { CommandModule } from "yargs";
import type { Account } from "ynab";

import type { AppContext } from "@/app/createAppContext";
import type { CliGlobalArgs } from "@/cli/types";
import { type OutputWriterOptions, createOutputWriter, fieldColumn, parseOutputFormat } from "@/io";

type AccountListRow = {
  id: string;
  name: string;
  type: string;
  onBudget: boolean;
  closed: boolean;
  balance: number;
};

type CliArgs = CliGlobalArgs & { appContext?: AppContext };

function accountRows(accounts: Account[]): AccountListRow[] {
  return accounts.map((account) => ({
    id: account.id,
    name: account.name,
    type: account.type,
    onBudget: account.on_budget,
    closed: account.closed,
    balance: account.balance,
  }));
}

export function writeAccountList(
  accounts: Account[],
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json", options).write(accounts);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write(accounts.map((account) => account.id));
    return;
  }

  const rows = accountRows(accounts);

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
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
          writeAccountList(accounts, format);
        },
      })
      .demandCommand(1, "Specify an account subcommand")
      .strict(),
  handler: () => {},
};
