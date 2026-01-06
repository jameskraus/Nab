import type { CommandModule } from "yargs";
import type { BudgetSummary } from "ynab";

import type { AppContext } from "@/app/createAppContext";
import type { CliGlobalArgs } from "@/cli/types";
import {
  type OutputWriterOptions,
  createOutputWriter,
  fieldColumn,
  formatDate,
  parseOutputFormat,
} from "@/io";

type BudgetListRow = {
  id: string;
  name: string;
  lastModified: string;
  firstMonth: string;
  lastMonth: string;
};

type CliArgs = CliGlobalArgs & { appContext?: AppContext };

function budgetRows(budgets: BudgetSummary[]): BudgetListRow[] {
  return budgets.map((budget) => ({
    id: budget.id,
    name: budget.name,
    lastModified: formatDate(budget.last_modified_on),
    firstMonth: formatDate(budget.first_month),
    lastMonth: formatDate(budget.last_month),
  }));
}

export function writeBudgetList(
  budgets: BudgetSummary[],
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json", options).write(budgets);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write(budgets.map((budget) => budget.id));
    return;
  }

  const rows = budgetRows(budgets);

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [
      fieldColumn("name", { header: "Name" }),
      fieldColumn("id", { header: "Id" }),
      fieldColumn("lastModified", { header: "Last Modified" }),
      fieldColumn("firstMonth", { header: "First Month" }),
      fieldColumn("lastMonth", { header: "Last Month" }),
    ],
    rows,
  });
}

export const budgetCommand: CommandModule<CliGlobalArgs> = {
  command: "budget <command>",
  describe: "Budgets",
  builder: (y) =>
    y
      .command({
        command: "list",
        describe: "List budgets available to the token",
        handler: async (argv) => {
          const { appContext, format } = argv as unknown as CliArgs;
          const ctx = appContext;
          if (!ctx?.ynab) {
            throw new Error("Missing YNAB client in app context.");
          }
          const budgets = await ctx.ynab.listBudgets();
          writeBudgetList(budgets, format);
        },
      })
      .command({
        command: "current",
        describe: "Show the effective budget (from --budget-id or config)",
        handler: () => {
          throw new Error("Not implemented yet (see docs/BEADS.md)");
        },
      })
      .demandCommand(1, "Specify a budget subcommand")
      .strict(),
  handler: () => {},
};
