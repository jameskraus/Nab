import type { Argv } from "yargs";
import type { CategoryGroupWithCategories, CurrencyFormat } from "ynab";

import { defineCommand } from "@/cli/command";
import { getOutputWriterOptions } from "@/cli/outputOptions";
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

export const categoryCommand = {
  command: "category <command>",
  describe: "Categories",
  builder: (y: Argv<Record<string, unknown>>) =>
    y
      .command(
        defineCommand({
          command: "list",
          describe: "List categories for the effective budget",
          requirements: { auth: true, budget: "required" },
          handler: async (argv, ctx) => {
            const groups = await ctx.ynab.listCategories(ctx.budgetId);
            const currencyFormat = await resolveBudgetCurrencyFormat(ctx, ctx.budgetId);
            writeCategoryList(groups, argv.format, {
              currencyFormat,
              ...getOutputWriterOptions(argv),
            });
          },
        }),
      )
      .demandCommand(1, "Specify a category subcommand")
      .strict(),
  handler: () => {},
} as const;
