import type { CommandModule } from "yargs";
import type { CategoryGroupWithCategories } from "ynab";

import type { AppContext } from "@/app/createAppContext";
import type { CliGlobalArgs } from "@/cli/types";
import { type OutputWriterOptions, createOutputWriter, fieldColumn, parseOutputFormat } from "@/io";

type CategoryListRow = {
  id: string;
  name: string;
  group: string;
  hidden: boolean;
  deleted: boolean;
  balance: number;
};

type CliArgs = CliGlobalArgs & { appContext?: AppContext };

function categoryRows(groups: CategoryGroupWithCategories[]): CategoryListRow[] {
  const rows: CategoryListRow[] = [];
  for (const group of groups) {
    for (const category of group.categories) {
      rows.push({
        id: category.id,
        name: category.name,
        group: category.category_group_name ?? group.name,
        hidden: category.hidden,
        deleted: category.deleted,
        balance: category.balance,
      });
    }
  }
  return rows;
}

export function writeCategoryList(
  groups: CategoryGroupWithCategories[],
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");
  const rows = categoryRows(groups);

  if (format === "json") {
    createOutputWriter("json", options).write(rows);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write(rows.map((row) => row.id));
    return;
  }

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
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
          writeCategoryList(groups, format);
        },
      })
      .demandCommand(1, "Specify a category subcommand")
      .strict(),
  handler: () => {},
};
