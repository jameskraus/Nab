import type { Argv } from "yargs";
import type { Payee } from "ynab";

import { defineCommand } from "@/cli/command";
import { getOutputWriterOptions } from "@/cli/outputOptions";
import { type OutputWriterOptions, createOutputWriter, fieldColumn, parseOutputFormat } from "@/io";

type PayeeListRow = {
  id: string;
  name: string;
  transferAccountId: string | null | undefined;
  deleted: boolean;
};

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

export const payeeCommand = {
  command: "payee <command>",
  describe: "Payees",
  builder: (y: Argv<Record<string, unknown>>) =>
    y
      .command(
        defineCommand({
          command: "list",
          describe: "List payees for the effective budget",
          requirements: { auth: true, budget: "required" },
          handler: async (argv, ctx) => {
            const payees = await ctx.ynab.listPayees(ctx.budgetId);
            writePayeeList(payees, argv.format, getOutputWriterOptions(argv));
          },
        }),
      )
      .demandCommand(1, "Specify a payee subcommand")
      .strict(),
  handler: () => {},
} as const;
