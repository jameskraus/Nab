import type { Category, MonthDetail, MonthSummary } from "ynab";

import type { YnabApiClient } from "@/api/YnabClient";

export type CategoryBudgetClient = Pick<
  YnabApiClient,
  "getBudgetMonth" | "listBudgetMonths" | "updateMonthCategory"
>;

export type CategoryAssignmentStatus = "updated" | "noop" | "dry-run";

export type CategoryAssignmentResult = {
  categoryId: string;
  categoryName: string;
  month: string;
  status: CategoryAssignmentStatus;
  previousAssignedMilliunits: number;
  assignedMilliunits: number;
  deltaMilliunits: number;
  readyToAssignGuardMonth: string;
  readyToAssignBeforeMilliunits: number;
  readyToAssignProjectedMilliunits: number;
  readyToAssignAfterMonth: string;
  readyToAssignAfterMilliunits: number;
  readyToAssignAfterVerified: boolean;
  wouldOverAssign: boolean;
  verified: boolean;
  reconciledAfterWriteError: boolean;
};

export type SetCategoryAssignedOptions = {
  dryRun?: boolean;
  expectedCurrentMilliunits?: number;
  allowOverAssigned?: boolean;
  allowNegativeAssigned?: boolean;
};

function findActiveCategory(month: MonthDetail, categoryId: string): Category {
  const category = month.categories.find((candidate) => candidate.id === categoryId);
  if (!category || category.deleted) {
    throw new Error(`Category not found in ${month.month}: ${categoryId}`);
  }
  if ((category as Category & { internal?: boolean }).internal === true) {
    throw new Error("Internal YNAB categories cannot be assigned directly.");
  }
  return category;
}

function assertMilliunits(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must resolve to a whole number of milliunits.`);
  }
}

type ReadyToAssignSnapshot = {
  month: string;
  amountMilliunits: number;
};

function futureMostReadyToAssign(
  editedMonth: Pick<MonthSummary, "month" | "to_be_budgeted">,
  months: readonly MonthSummary[],
): ReadyToAssignSnapshot {
  const byMonth = new Map<string, ReadyToAssignSnapshot>();
  for (const month of months) {
    if (month.deleted || month.month < editedMonth.month) continue;
    byMonth.set(month.month, {
      month: month.month,
      amountMilliunits: month.to_be_budgeted,
    });
  }
  if (!byMonth.has(editedMonth.month)) {
    byMonth.set(editedMonth.month, {
      month: editedMonth.month,
      amountMilliunits: editedMonth.to_be_budgeted,
    });
  }

  const latest = [...byMonth.values()].sort((left, right) =>
    right.month.localeCompare(left.month),
  )[0];
  if (!latest) {
    throw new Error(`Ready to Assign is unavailable for ${editedMonth.month}.`);
  }
  return latest;
}

export class CategoryBudgetService {
  constructor(
    private readonly client: CategoryBudgetClient,
    private readonly budgetId: string,
  ) {}

  async setAssigned(
    categoryId: string,
    month: string,
    assignedMilliunits: number,
    options: SetCategoryAssignedOptions = {},
  ): Promise<CategoryAssignmentResult> {
    const normalizedId = categoryId.trim();
    if (!normalizedId) {
      throw new Error("Category id must not be empty.");
    }
    assertMilliunits(assignedMilliunits, "Assigned amount");
    if (options.expectedCurrentMilliunits !== undefined) {
      assertMilliunits(options.expectedCurrentMilliunits, "Expected current amount");
    }
    if (assignedMilliunits < 0 && !options.allowNegativeAssigned) {
      throw new Error("Assigned amount cannot be negative without --allow-negative-assigned.");
    }

    const [before, monthsBefore] = await Promise.all([
      this.client.getBudgetMonth(this.budgetId, month),
      this.client.listBudgetMonths(this.budgetId),
    ]);
    const category = findActiveCategory(before, normalizedId);
    const previousAssignedMilliunits = category.budgeted;

    if (
      options.expectedCurrentMilliunits !== undefined &&
      previousAssignedMilliunits !== options.expectedCurrentMilliunits
    ) {
      throw new Error(
        `Category assigned amount changed: expected ${options.expectedCurrentMilliunits} milliunits, found ${previousAssignedMilliunits}.`,
      );
    }

    const deltaMilliunits = assignedMilliunits - previousAssignedMilliunits;
    const readyToAssignBefore = futureMostReadyToAssign(before, monthsBefore);
    const readyToAssignProjectedMilliunits = readyToAssignBefore.amountMilliunits - deltaMilliunits;
    const wouldOverAssign = readyToAssignProjectedMilliunits < 0;
    const baseResult = {
      categoryId: normalizedId,
      categoryName: category.name,
      month: before.month,
      previousAssignedMilliunits,
      assignedMilliunits,
      deltaMilliunits,
      readyToAssignGuardMonth: readyToAssignBefore.month,
      readyToAssignBeforeMilliunits: readyToAssignBefore.amountMilliunits,
      readyToAssignProjectedMilliunits,
      wouldOverAssign,
    };

    if (deltaMilliunits === 0) {
      return {
        ...baseResult,
        status: "noop",
        readyToAssignAfterMonth: readyToAssignBefore.month,
        readyToAssignAfterMilliunits: readyToAssignBefore.amountMilliunits,
        readyToAssignAfterVerified: true,
        verified: true,
        reconciledAfterWriteError: false,
      };
    }

    if (options.dryRun) {
      return {
        ...baseResult,
        status: "dry-run",
        readyToAssignAfterMonth: readyToAssignBefore.month,
        readyToAssignAfterMilliunits: readyToAssignProjectedMilliunits,
        readyToAssignAfterVerified: false,
        verified: false,
        reconciledAfterWriteError: false,
      };
    }

    if (wouldOverAssign && deltaMilliunits > 0 && !options.allowOverAssigned) {
      throw new Error(
        "This assignment would make Ready to Assign negative. Re-run with --allow-over-assigned only after reviewing the dry-run.",
      );
    }

    let reconciledAfterWriteError = false;
    try {
      const updated = await this.client.updateMonthCategory(
        this.budgetId,
        before.month,
        normalizedId,
        assignedMilliunits,
      );
      if (updated.id !== normalizedId || updated.budgeted !== assignedMilliunits) {
        const reconciled = await this.client.getBudgetMonth(this.budgetId, before.month);
        const reconciledCategory = findActiveCategory(reconciled, normalizedId);
        if (reconciledCategory.budgeted !== assignedMilliunits) {
          throw new Error(
            `YNAB verification failed: expected ${assignedMilliunits} assigned milliunits, found ${reconciledCategory.budgeted}.`,
          );
        }
      }
    } catch (writeError) {
      let reconciled: MonthDetail;
      try {
        reconciled = await this.client.getBudgetMonth(this.budgetId, before.month);
      } catch {
        throw new Error(
          "YNAB assignment outcome is unknown because the write failed and the follow-up read also failed. Inspect the category before retrying.",
          { cause: writeError },
        );
      }
      const reconciledCategory = findActiveCategory(reconciled, normalizedId);
      if (reconciledCategory.budgeted === previousAssignedMilliunits) {
        throw writeError;
      }
      if (reconciledCategory.budgeted !== assignedMilliunits) {
        throw new Error(
          `YNAB assignment outcome is ambiguous: expected ${assignedMilliunits} assigned milliunits, found ${reconciledCategory.budgeted}. Inspect the category before retrying.`,
          { cause: writeError },
        );
      }
      reconciledAfterWriteError = true;
    }

    let readyToAssignAfter: ReadyToAssignSnapshot = {
      month: readyToAssignBefore.month,
      amountMilliunits: readyToAssignProjectedMilliunits,
    };
    let readyToAssignAfterVerified = false;
    try {
      const monthsAfter = await this.client.listBudgetMonths(this.budgetId);
      readyToAssignAfter = futureMostReadyToAssign(
        {
          month: before.month,
          to_be_budgeted:
            before.month === readyToAssignBefore.month
              ? readyToAssignProjectedMilliunits
              : before.to_be_budgeted - deltaMilliunits,
        },
        monthsAfter,
      );
      readyToAssignAfterVerified = true;
    } catch {
      // The category update response (or reconciliation read) already verified the write. Keep
      // the projected RTA so the applied mutation can still be journaled after a later read fails.
    }

    return {
      ...baseResult,
      status: "updated",
      readyToAssignAfterMonth: readyToAssignAfter.month,
      readyToAssignAfterMilliunits: readyToAssignAfter.amountMilliunits,
      readyToAssignAfterVerified,
      wouldOverAssign: wouldOverAssign || readyToAssignAfter.amountMilliunits < 0,
      verified: true,
      reconciledAfterWriteError,
    };
  }
}
