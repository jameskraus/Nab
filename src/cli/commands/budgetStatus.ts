import type { Argv } from "yargs";
import type { CurrencyFormat } from "ynab";

import type { AppContext } from "@/app/createAppContext";
import { defineCommand } from "@/cli/command";
import { getOutputWriterOptions } from "@/cli/outputOptions";
import { resolveBudgetCurrencyFormat } from "@/domain/budgetCurrency";
import {
  type BudgetHealthCategory,
  type BudgetHealthSummary,
  buildBudgetHealthSummary,
} from "@/domain/budgetHealth";
import { parseDateOnly } from "@/domain/dateOnly";
import {
  type OutputWriterOptions,
  createOutputWriter,
  fieldColumn,
  formatCurrency,
  parseOutputFormat,
} from "@/io";

type BudgetStatusArgs = {
  month: string;
  all?: boolean;
  format?: string;
  quiet?: boolean;
  noColor?: boolean;
};

type MoneyOutput = {
  amount: string;
  amount_display: string;
  raw_amount: number;
};

type BudgetStatusCategoryOutput = {
  id: string;
  category_group_id: string;
  category_group_name: string;
  name: string;
  hidden: boolean;
  internal: boolean | null;
  assigned: MoneyOutput;
  activity: MoneyOutput;
  available: MoneyOutput;
  target_type: string | null;
  target: MoneyOutput | null;
  target_date: string | null;
  target_percentage_complete: number | null;
  target_shortfall: MoneyOutput;
  issues: BudgetHealthCategory["issues"];
};

export type BudgetStatusOutput = {
  schema_version: 1;
  budget_id: string;
  month: string;
  totals: {
    income: MoneyOutput;
    assigned: MoneyOutput;
    activity: MoneyOutput;
    ready_to_assign: MoneyOutput;
  };
  ready_to_assign: {
    state: BudgetHealthSummary["readyToAssign"]["state"];
    issues: BudgetHealthSummary["readyToAssign"]["issues"];
    value: MoneyOutput;
  };
  counts: {
    returned: number;
    overspent: number;
    target_shortfall: number;
    zero_assigned_target: number;
  };
  deficits: {
    overspent: MoneyOutput;
    target_shortfall: MoneyOutput;
  };
  categories: BudgetStatusCategoryOutput[];
};

type BudgetStatusRow = {
  group: string;
  category: string;
  assigned: string;
  activity: string;
  available: string;
  targetShortfall: string;
  issues: string;
  hidden: boolean;
  internal: boolean | null;
  id: string;
};

export function parseBudgetMonth(input: string): string {
  const normalized = input.trim().toLowerCase();
  if (normalized === "current") return "current";
  const month = parseDateOnly(normalized);
  if (!month.endsWith("-01")) {
    throw new Error("Budget month must be current or the first day of a month (YYYY-MM-01).");
  }
  return month;
}

function money(value: number, format?: CurrencyFormat | null): MoneyOutput {
  const display = formatCurrency(value, format);
  return {
    amount: display,
    amount_display: display,
    raw_amount: value,
  };
}

function categoryOutput(
  category: BudgetHealthCategory,
  format?: CurrencyFormat | null,
): BudgetStatusCategoryOutput {
  return {
    id: category.id,
    category_group_id: category.categoryGroupId,
    category_group_name: category.categoryGroupName,
    name: category.name,
    hidden: category.hidden,
    internal: category.internal ?? null,
    assigned: money(category.assignedMilliunits, format),
    activity: money(category.activityMilliunits, format),
    available: money(category.availableMilliunits, format),
    target_type: category.targetType,
    target: category.targetMilliunits === null ? null : money(category.targetMilliunits, format),
    target_date: category.targetDate,
    target_percentage_complete: category.targetPercentageComplete,
    target_shortfall: money(category.targetShortfallMilliunits, format),
    issues: category.issues,
  };
}

function budgetStatusOutput(
  budgetId: string,
  summary: BudgetHealthSummary,
  currencyFormat?: CurrencyFormat | null,
): BudgetStatusOutput {
  return {
    schema_version: 1,
    budget_id: budgetId,
    month: summary.month,
    totals: {
      income: money(summary.totals.incomeMilliunits, currencyFormat),
      assigned: money(summary.totals.assignedMilliunits, currencyFormat),
      activity: money(summary.totals.activityMilliunits, currencyFormat),
      ready_to_assign: money(summary.totals.readyToAssignMilliunits, currencyFormat),
    },
    ready_to_assign: {
      state: summary.readyToAssign.state,
      issues: summary.readyToAssign.issues,
      value: money(summary.readyToAssign.amountMilliunits, currencyFormat),
    },
    counts: {
      returned: summary.counts.categories,
      overspent: summary.counts.overspent,
      target_shortfall: summary.counts.targetShortfall,
      zero_assigned_target: summary.counts.zeroAssignedTarget,
    },
    deficits: {
      overspent: money(summary.deficits.overspentMilliunits, currencyFormat),
      target_shortfall: money(summary.deficits.targetShortfallMilliunits, currencyFormat),
    },
    categories: summary.categories.map((category) => categoryOutput(category, currencyFormat)),
  };
}

function budgetStatusRows(status: BudgetStatusOutput): BudgetStatusRow[] {
  return status.categories.map((category) => ({
    group: category.category_group_name,
    category: category.name,
    assigned: category.assigned.amount_display,
    activity: category.activity.amount_display,
    available: category.available.amount_display,
    targetShortfall: category.target_shortfall.amount_display,
    issues: category.issues.join(","),
    hidden: category.hidden,
    internal: category.internal,
    id: category.id,
  }));
}

export function writeBudgetStatus(
  status: BudgetStatusOutput,
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");
  if (format === "json") {
    createOutputWriter("json", options).write(status);
    return;
  }
  if (format === "ids") {
    createOutputWriter("ids", options).write(status.categories.map((category) => category.id));
    return;
  }

  const rows = budgetStatusRows(status);
  if (format === "tsv") {
    createOutputWriter("tsv", options).write(
      rows.map((row) => ({
        month: status.month,
        readyToAssign: status.ready_to_assign.value.amount_display,
        readyToAssignState: status.ready_to_assign.state,
        ...row,
      })),
    );
    return;
  }

  const stdout = options?.stdout ?? process.stdout;
  stdout.write(`Budget month: ${status.month}\n`);
  stdout.write(
    `Ready to Assign: ${status.ready_to_assign.value.amount_display} (${status.ready_to_assign.state})\n`,
  );
  stdout.write(
    `Categories returned: ${status.counts.returned}; overspent ${status.counts.overspent}; ` +
      `target shortfall ${status.counts.target_shortfall}; zero assigned with target ${status.counts.zero_assigned_target}\n`,
  );
  if (rows.length === 0) return;

  createOutputWriter("table", options).write({
    columns: [
      fieldColumn("group", { header: "Group" }),
      fieldColumn("category", { header: "Category" }),
      fieldColumn("assigned", { header: "Assigned", align: "right" }),
      fieldColumn("activity", { header: "Activity", align: "right" }),
      fieldColumn("available", { header: "Available", align: "right" }),
      fieldColumn("targetShortfall", { header: "Target Shortfall", align: "right" }),
      fieldColumn("issues", { header: "Issues" }),
      fieldColumn("hidden", { header: "Hidden" }),
      fieldColumn("internal", { header: "Internal" }),
      fieldColumn("id", { header: "Id" }),
    ],
    rows,
  });
}

export const budgetStatusCommand = defineCommand({
  command: "status",
  describe: "Show monthly budget health and categories needing attention",
  requirements: { auth: true, budget: "required" },
  builder: (y: Argv<Record<string, unknown>>) =>
    y
      .option("month", {
        type: "string",
        default: "current",
        describe: "Budget month: current or YYYY-MM-01",
      })
      .option("all", {
        type: "boolean",
        default: false,
        describe: "Include healthy, hidden, and internal categories as well as attention items",
      })
      .check((argv) => {
        if (typeof argv.month === "string") {
          argv.month = parseBudgetMonth(argv.month);
        }
        return true;
      }),
  handler: async (argv, ctx) => {
    const args = argv as unknown as BudgetStatusArgs;
    const [month, currencyFormat] = await Promise.all([
      ctx.ynab.getBudgetMonth(ctx.budgetId, args.month),
      resolveBudgetCurrencyFormat(ctx as AppContext, ctx.budgetId),
    ]);
    const summary = buildBudgetHealthSummary(month, { includeHealthy: Boolean(args.all) });
    const status = budgetStatusOutput(ctx.budgetId, summary, currencyFormat);
    writeBudgetStatus(status, args.format, getOutputWriterOptions(args));
  },
});
