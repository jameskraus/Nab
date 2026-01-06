import type { CommandModule } from "yargs";
import type { Payee } from "ynab";

import type { AppContext } from "@/app/createAppContext";
import type { CliGlobalArgs } from "@/cli/types";
import { type OutputWriterOptions, createOutputWriter, fieldColumn, parseOutputFormat } from "@/io";

type PayeeListRow = {
  id: string;
  name: string;
  transferAccountId: string | null | undefined;
  deleted: boolean;
};

type CliArgs = CliGlobalArgs & { appContext?: AppContext };

function payeeRows(payees: Payee[]): PayeeListRow[] {
  return payees.map((payee) => ({
    id: payee.id,
    name: payee.name,
    transferAccountId: payee.transfer_account_id,
    deleted: payee.deleted,
  }));
}

export function writePayeeList(
  payees: Payee[],
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json", options).write(payees);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write(payees.map((payee) => payee.id));
    return;
  }

  const rows = payeeRows(payees);

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [
      fieldColumn("name", { header: "Name" }),
      fieldColumn("id", { header: "Id" }),
      fieldColumn("transferAccountId", { header: "Transfer Account" }),
      fieldColumn("deleted", { header: "Deleted" }),
    ],
    rows,
  });
}

export const payeeCommand: CommandModule<CliGlobalArgs> = {
  command: "payee <command>",
  describe: "Payees",
  builder: (y) =>
    y
      .command({
        command: "list",
        describe: "List payees for the effective budget",
        handler: async (argv) => {
          const { appContext, format } = argv as unknown as CliArgs;
          const ctx = appContext;
          if (!ctx?.ynab || !ctx.budgetId) {
            throw new Error("Missing budget context for payee list.");
          }
          const payees = await ctx.ynab.listPayees(ctx.budgetId);
          writePayeeList(payees, format);
        },
      })
      .demandCommand(1, "Specify a payee subcommand")
      .strict(),
  handler: () => {},
};
