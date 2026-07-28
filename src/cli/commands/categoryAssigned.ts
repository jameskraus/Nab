import type { Argv } from "yargs";
import type { CurrencyFormat } from "ynab";

import { defineCommand } from "@/cli/command";
import { requireApplyConfirmation } from "@/cli/mutations";
import { getOutputWriterOptions } from "@/cli/outputOptions";
import {
  type CategoryAssignmentResult,
  CategoryBudgetService,
} from "@/domain/CategoryBudgetService";
import { resolveBudgetCurrencyFormat } from "@/domain/budgetCurrency";
import { parseDateOnly } from "@/domain/dateOnly";
import { parseAmountToMilliunits } from "@/domain/inputs";
import {
  type OutputWriterOptions,
  createOutputWriter,
  fieldColumn,
  formatCurrency,
  parseOutputFormat,
} from "@/io";
import { normalizeArgv } from "@/journal/argv";
import { recordHistoryAction } from "@/journal/history";

type CategoryAssignedArgs = {
  id: string;
  month: string;
  amount: string;
  expectedCurrent?: string;
  allowOverAssigned?: boolean;
  allowNegativeAssigned?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  format?: string;
  quiet?: boolean;
  noColor?: boolean;
};

export type CategoryAssignmentOutput = {
  id: string;
  category: string;
  month: string;
  status: CategoryAssignmentResult["status"];
  previous_assigned: string;
  previous_assigned_display: string;
  raw_previous_assigned: number;
  assigned: string;
  assigned_display: string;
  raw_assigned: number;
  delta: string;
  delta_display: string;
  raw_delta: number;
  ready_to_assign_guard_month: string;
  ready_to_assign_before: string;
  ready_to_assign_before_display: string;
  raw_ready_to_assign_before: number;
  ready_to_assign_projected: string;
  ready_to_assign_projected_display: string;
  raw_ready_to_assign_projected: number;
  ready_to_assign_after_month: string;
  ready_to_assign_after: string;
  ready_to_assign_after_display: string;
  raw_ready_to_assign_after: number;
  ready_to_assign_after_verified: boolean;
  would_over_assign: boolean;
  verified: boolean;
  reconciled_after_write_error: boolean;
};

export function parseAssignmentMonth(input: string): string {
  const month = parseDateOnly(input);
  if (!month.endsWith("-01")) {
    throw new Error("Assignment month must be the first day of a month (YYYY-MM-01).");
  }
  return month;
}

function display(value: number, currencyFormat?: CurrencyFormat | null): string {
  return formatCurrency(value, currencyFormat);
}

function assignmentOutput(
  result: CategoryAssignmentResult,
  currencyFormat?: CurrencyFormat | null,
): CategoryAssignmentOutput {
  const previousAssigned = display(result.previousAssignedMilliunits, currencyFormat);
  const assigned = display(result.assignedMilliunits, currencyFormat);
  const delta = display(result.deltaMilliunits, currencyFormat);
  const readyToAssignBefore = display(result.readyToAssignBeforeMilliunits, currencyFormat);
  const readyToAssignProjected = display(result.readyToAssignProjectedMilliunits, currencyFormat);
  const readyToAssignAfter = display(result.readyToAssignAfterMilliunits, currencyFormat);
  return {
    id: result.categoryId,
    category: result.categoryName,
    month: result.month,
    status: result.status,
    previous_assigned: previousAssigned,
    previous_assigned_display: previousAssigned,
    raw_previous_assigned: result.previousAssignedMilliunits,
    assigned,
    assigned_display: assigned,
    raw_assigned: result.assignedMilliunits,
    delta,
    delta_display: delta,
    raw_delta: result.deltaMilliunits,
    ready_to_assign_guard_month: result.readyToAssignGuardMonth,
    ready_to_assign_before: readyToAssignBefore,
    ready_to_assign_before_display: readyToAssignBefore,
    raw_ready_to_assign_before: result.readyToAssignBeforeMilliunits,
    ready_to_assign_projected: readyToAssignProjected,
    ready_to_assign_projected_display: readyToAssignProjected,
    raw_ready_to_assign_projected: result.readyToAssignProjectedMilliunits,
    ready_to_assign_after_month: result.readyToAssignAfterMonth,
    ready_to_assign_after: readyToAssignAfter,
    ready_to_assign_after_display: readyToAssignAfter,
    raw_ready_to_assign_after: result.readyToAssignAfterMilliunits,
    ready_to_assign_after_verified: result.readyToAssignAfterVerified,
    would_over_assign: result.wouldOverAssign,
    verified: result.verified,
    reconciled_after_write_error: result.reconciledAfterWriteError,
  };
}

export function writeCategoryAssignment(
  result: CategoryAssignmentOutput,
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");
  if (format === "json") {
    createOutputWriter("json", options).write(result);
    return;
  }
  if (format === "ids") {
    createOutputWriter("ids", options).write([result.id]);
    return;
  }
  if (format === "tsv") {
    createOutputWriter("tsv", options).write([result]);
    return;
  }
  createOutputWriter("table", options).write({
    columns: [
      fieldColumn("status", { header: "Status" }),
      fieldColumn("month", { header: "Month" }),
      fieldColumn("category", { header: "Category" }),
      fieldColumn("previous_assigned", { header: "Previous", align: "right" }),
      fieldColumn("assigned", { header: "Assigned", align: "right" }),
      fieldColumn("delta", { header: "Delta", align: "right" }),
      fieldColumn("ready_to_assign_guard_month", {
        header: "RTA Guard Month",
      }),
      fieldColumn("ready_to_assign_before", {
        header: "RTA Before",
        align: "right",
      }),
      fieldColumn("ready_to_assign_projected", {
        header: "RTA Projected",
        align: "right",
      }),
      fieldColumn("ready_to_assign_after_verified", {
        header: "RTA Verified",
      }),
      fieldColumn("verified", { header: "Verified" }),
      fieldColumn("id", { header: "Category Id" }),
    ],
    rows: [result],
  });
}

export const categoryAssignedCommand = defineCommand({
  command: "set-assigned",
  describe: "Set the absolute assigned amount for one category and month",
  requirements: { auth: true, budget: "required", db: true, mutation: true },
  builder: (y: Argv<Record<string, unknown>>) =>
    y
      .option("id", {
        type: "string",
        demandOption: true,
        describe: "Exact category id",
      })
      .option("month", {
        type: "string",
        demandOption: true,
        describe: "Exact budget month (YYYY-MM-01)",
      })
      .option("amount", {
        type: "string",
        demandOption: true,
        describe: "Absolute assigned total in budget currency",
      })
      .option("expected-current", {
        type: "string",
        describe: "Required on apply: expected current assigned total",
      })
      .option("allow-over-assigned", {
        type: "boolean",
        default: false,
        describe: "Allow the assignment to make Ready to Assign negative",
      })
      .option("allow-negative-assigned", {
        type: "boolean",
        default: false,
        describe: "Allow an absolute assigned total below zero",
      })
      .check((argv) => {
        if (typeof argv.id !== "string" || argv.id.trim().length === 0) {
          throw new Error("Provide a non-empty --id.");
        }
        if (typeof argv.month === "string") {
          argv.month = parseAssignmentMonth(argv.month);
        }
        return true;
      }),
  handler: async (argv, ctx) => {
    const args = argv as unknown as CategoryAssignedArgs;
    const dryRun = Boolean(args.dryRun);
    requireApplyConfirmation(dryRun, Boolean(args.yes));
    if (!dryRun && args.expectedCurrent === undefined) {
      throw new Error(
        "Provide --expected-current when applying. Use --dry-run first to see the current assigned amount.",
      );
    }

    const currencyFormat = await resolveBudgetCurrencyFormat(ctx, ctx.budgetId);
    const assignedMilliunits = parseAmountToMilliunits(args.amount, currencyFormat);
    const expectedCurrentMilliunits =
      args.expectedCurrent === undefined
        ? undefined
        : parseAmountToMilliunits(args.expectedCurrent, currencyFormat);
    const service = new CategoryBudgetService(ctx.ynab, ctx.budgetId);
    const result = await service.setAssigned(args.id.trim(), args.month, assignedMilliunits, {
      dryRun,
      expectedCurrentMilliunits,
      allowOverAssigned: Boolean(args.allowOverAssigned),
      allowNegativeAssigned: Boolean(args.allowNegativeAssigned),
    });

    if (result.status === "updated") {
      recordHistoryAction(
        ctx.db,
        "category.assigned.set",
        {
          argv: normalizeArgv(argv as Record<string, unknown>),
          txIds: [],
          targets: [
            {
              resource: "month_category",
              id: result.categoryId,
              month: result.month,
            },
          ],
          patches: [
            {
              resource: "month_category",
              id: result.categoryId,
              month: result.month,
              patch: { budgeted: result.assignedMilliunits },
            },
          ],
        },
        [
          {
            resource: "month_category",
            id: result.categoryId,
            month: result.month,
            patch: { budgeted: result.previousAssignedMilliunits },
          },
        ],
      );
    }

    writeCategoryAssignment(
      assignmentOutput(result, currencyFormat),
      args.format,
      getOutputWriterOptions(args),
    );
  },
});
