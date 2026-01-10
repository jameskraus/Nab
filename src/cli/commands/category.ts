import type { CommandModule } from "yargs";
import type { CategoryGroupWithCategories, CurrencyFormat } from "ynab";

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

type CategoryListRow = {
  id: string;
  name: string;
  group: string;
  hidden: boolean;
  deleted: boolean;
  balance: string;
};

type CliArgs = CliGlobalArgs & { appContext?: AppContext };

type CategoryListRowJson = CategoryListRow & {
  balance_display: string;
  raw_balance: number;
};

type MoneyWriterOptions = OutputWriterOptions & { currencyFormat?: CurrencyFormat | null };

function categoryRows(
  groups: CategoryGroupWithCategories[],
  currencyFormat?: CurrencyFormat | null,
): CategoryListRow[] {
  const rows: CategoryListRow[] = [];
  for (const group of groups) {
    for (const category of group.categories) {
      const balanceDisplay = formatCurrency(category.balance, currencyFormat);
      rows.push({
        id: category.id,
        name: category.name,
        group: category.category_group_name ?? group.name,
        hidden: category.hidden,
        deleted: category.deleted,
        balance: balanceDisplay,
      });
    }
  }
  return rows;
}

export function writeCategoryList(
  groups: CategoryGroupWithCategories[],
  rawFormat?: string,
  options?: MoneyWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");
  const { currencyFormat, ...writerOptions } = options ?? {};

  if (format === "json") {
    const rows: CategoryListRowJson[] = [];
    for (const group of groups) {
      for (const category of group.categories) {
        const balanceDisplay = formatCurrency(category.balance, currencyFormat);
        rows.push({
          id: category.id,
          name: category.name,
          group: category.category_group_name ?? group.name,
          hidden: category.hidden,
          deleted: category.deleted,
          balance: balanceDisplay,
          balance_display: balanceDisplay,
          raw_balance: category.balance,
        });
      }
    }
    createOutputWriter("json", writerOptions).write(rows);
    return;
  }

  if (format === "ids") {
    const rows = categoryRows(groups, currencyFormat);
    createOutputWriter("ids", writerOptions).write(rows.map((row) => row.id));
    return;
  }

  const rows = categoryRows(groups, currencyFormat);

  if (format === "tsv") {
    createOutputWriter("tsv", writerOptions).write(rows);
    return;
  }

  createOutputWriter("table", writerOptions).write({
    columns: [
      fieldColumn("group", { header: "Group" }),
      fieldColumn("name", { header: "Name" }),
      fieldColumn("id", { header: "Id" }),
      fieldColumn("hidden", { header: "Hidden" }),
      fieldColumn("deleted", { header: "Deleted" }),
      fieldColumn("balance", { header: "Balance", align: "right" }),
    ],
    rows,
  });
}

export const categoryCommand: CommandModule<CliGlobalArgs> = {
  command: "category <command>",
  describe: "Categories",
  builder: (y) =>
    y
      .command({
        command: "list",
        describe: "List categories for the effective budget",
        handler: async (argv) => {
          const { appContext, format } = argv as unknown as CliArgs;
          const ctx = appContext;
          if (!ctx?.ynab || !ctx.budgetId) {
            throw new Error("Missing budget context for category list.");
          }
          const groups = await ctx.ynab.listCategories(ctx.budgetId);
          const currencyFormat = await resolveBudgetCurrencyFormat(ctx, ctx.budgetId);
          writeCategoryList(groups, format, { currencyFormat });
        },
      })
      .demandCommand(1, "Specify a category subcommand")
      .strict(),
  handler: () => {},
};
