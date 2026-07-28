import { describe, expect, test } from "bun:test";
import type { Category, MonthDetail, MonthSummary } from "ynab";

import { type CategoryBudgetClient, CategoryBudgetService } from "@/domain/CategoryBudgetService";

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: "category-1",
    category_group_id: "group-1",
    name: "Rent",
    hidden: false,
    budgeted: 100_000,
    activity: -25_000,
    balance: 75_000,
    deleted: false,
    ...overrides,
  } as Category;
}

function makeMonth(overrides: Partial<MonthDetail> = {}): MonthDetail {
  return {
    month: "2026-07-01",
    note: null,
    income: 4_000_000,
    budgeted: 3_500_000,
    activity: -2_000_000,
    to_be_budgeted: 500_000,
    age_of_money: 30,
    deleted: false,
    categories: [makeCategory()],
    ...overrides,
  } as MonthDetail;
}

function monthSummary(month: MonthDetail): MonthSummary {
  const { categories: _categories, ...summary } = month;
  return structuredClone(summary);
}

class MemoryCategoryBudgetClient implements CategoryBudgetClient {
  readonly updates: Array<{
    budgetId: string;
    month: string;
    categoryId: string;
    budgetedMilliunits: number;
  }> = [];

  private readonly months: MonthSummary[];
  private updated = false;

  constructor(
    private currentMonth: MonthDetail,
    options: {
      months?: MonthSummary[];
      throwAfterUpdate?: boolean;
      failMonthListAfterUpdate?: boolean;
    } = {},
  ) {
    this.months = structuredClone(options.months ?? [monthSummary(currentMonth)]);
    this.throwAfterUpdate = options.throwAfterUpdate ?? false;
    this.failMonthListAfterUpdate = options.failMonthListAfterUpdate ?? false;
  }

  private readonly throwAfterUpdate: boolean;
  private readonly failMonthListAfterUpdate: boolean;

  async getBudgetMonth(): Promise<MonthDetail> {
    return structuredClone(this.currentMonth);
  }

  async listBudgetMonths(): Promise<MonthSummary[]> {
    if (this.updated && this.failMonthListAfterUpdate) {
      throw new Error("post-write month list failed");
    }
    return structuredClone(this.months);
  }

  async updateMonthCategory(
    budgetId: string,
    month: string,
    categoryId: string,
    budgetedMilliunits: number,
  ): Promise<Category> {
    this.updates.push({ budgetId, month, categoryId, budgetedMilliunits });
    const category = this.currentMonth.categories.find((candidate) => candidate.id === categoryId);
    if (!category) throw new Error("missing category");
    const delta = budgetedMilliunits - category.budgeted;
    category.budgeted = budgetedMilliunits;
    this.currentMonth.budgeted += delta;
    this.currentMonth.to_be_budgeted -= delta;
    for (const summary of this.months) {
      if (summary.month < this.currentMonth.month) continue;
      summary.to_be_budgeted -= delta;
      if (summary.month === this.currentMonth.month) {
        summary.budgeted += delta;
      }
    }
    this.updated = true;
    if (this.throwAfterUpdate) {
      throw new Error("connection closed after update");
    }
    return structuredClone(category);
  }
}

describe("CategoryBudgetService", () => {
  test("previews an absolute assignment without writing", async () => {
    const client = new MemoryCategoryBudgetClient(makeMonth());
    const service = new CategoryBudgetService(client, "budget-1");

    const result = await service.setAssigned("category-1", "2026-07-01", 250_000, {
      dryRun: true,
    });

    expect(result).toMatchObject({
      status: "dry-run",
      previousAssignedMilliunits: 100_000,
      assignedMilliunits: 250_000,
      deltaMilliunits: 150_000,
      readyToAssignBeforeMilliunits: 500_000,
      readyToAssignProjectedMilliunits: 350_000,
      readyToAssignAfterMilliunits: 350_000,
      wouldOverAssign: false,
      verified: false,
    });
    expect(client.updates).toEqual([]);
  });

  test("applies and verifies an absolute assignment", async () => {
    const client = new MemoryCategoryBudgetClient(makeMonth());
    const service = new CategoryBudgetService(client, "budget-1");

    const result = await service.setAssigned("category-1", "2026-07-01", 250_000, {
      expectedCurrentMilliunits: 100_000,
    });

    expect(result).toMatchObject({
      status: "updated",
      readyToAssignAfterMilliunits: 350_000,
      verified: true,
    });
    expect(client.updates).toEqual([
      {
        budgetId: "budget-1",
        month: "2026-07-01",
        categoryId: "category-1",
        budgetedMilliunits: 250_000,
      },
    ]);
  });

  test("returns noop for the existing absolute amount", async () => {
    const client = new MemoryCategoryBudgetClient(makeMonth());
    const service = new CategoryBudgetService(client, "budget-1");

    const result = await service.setAssigned("category-1", "2026-07-01", 100_000);

    expect(result.status).toBe("noop");
    expect(result.verified).toBe(true);
    expect(client.updates).toEqual([]);
  });

  test("rejects a stale expected-current guard", async () => {
    const service = new CategoryBudgetService(
      new MemoryCategoryBudgetClient(makeMonth()),
      "budget-1",
    );

    await expect(
      service.setAssigned("category-1", "2026-07-01", 250_000, {
        expectedCurrentMilliunits: 99_000,
      }),
    ).rejects.toThrow("expected 99000 milliunits, found 100000");
  });

  test("blocks worsening negative Ready to Assign unless overridden", async () => {
    const blockedClient = new MemoryCategoryBudgetClient(makeMonth({ to_be_budgeted: 50_000 }));
    const blockedService = new CategoryBudgetService(blockedClient, "budget-1");

    await expect(blockedService.setAssigned("category-1", "2026-07-01", 200_000)).rejects.toThrow(
      "would make Ready to Assign negative",
    );
    expect(blockedClient.updates).toEqual([]);

    const allowedClient = new MemoryCategoryBudgetClient(makeMonth({ to_be_budgeted: 50_000 }));
    const allowedService = new CategoryBudgetService(allowedClient, "budget-1");
    const result = await allowedService.setAssigned("category-1", "2026-07-01", 200_000, {
      allowOverAssigned: true,
    });

    expect(result.readyToAssignAfterMilliunits).toBe(-50_000);
    expect(result.wouldOverAssign).toBe(true);
  });

  test("guards against the future-most month Ready to Assign", async () => {
    const current = makeMonth({ to_be_budgeted: 100_000 });
    const future = {
      ...monthSummary(current),
      month: "2026-08-01",
      budgeted: 600_000,
      to_be_budgeted: 10_000,
    };
    const client = new MemoryCategoryBudgetClient(current, {
      months: [monthSummary(current), future],
    });
    const service = new CategoryBudgetService(client, "budget-1");

    await expect(service.setAssigned("category-1", "2026-07-01", 120_000)).rejects.toThrow(
      "would make Ready to Assign negative",
    );
    expect(client.updates).toEqual([]);

    const preview = await service.setAssigned("category-1", "2026-07-01", 120_000, {
      dryRun: true,
    });
    expect(preview).toMatchObject({
      readyToAssignGuardMonth: "2026-08-01",
      readyToAssignBeforeMilliunits: 10_000,
      readyToAssignProjectedMilliunits: -10_000,
      wouldOverAssign: true,
    });
  });

  test("reconciles a write whose response fails after YNAB applies it", async () => {
    const client = new MemoryCategoryBudgetClient(makeMonth(), {
      throwAfterUpdate: true,
    });
    const service = new CategoryBudgetService(client, "budget-1");

    const result = await service.setAssigned("category-1", "2026-07-01", 250_000, {
      expectedCurrentMilliunits: 100_000,
    });

    expect(result).toMatchObject({
      status: "updated",
      assignedMilliunits: 250_000,
      verified: true,
      reconciledAfterWriteError: true,
      readyToAssignAfterVerified: true,
    });
  });

  test("returns an applied result when only the post-write RTA refresh fails", async () => {
    const client = new MemoryCategoryBudgetClient(makeMonth(), {
      failMonthListAfterUpdate: true,
    });
    const service = new CategoryBudgetService(client, "budget-1");

    const result = await service.setAssigned("category-1", "2026-07-01", 250_000, {
      expectedCurrentMilliunits: 100_000,
    });

    expect(result).toMatchObject({
      status: "updated",
      assignedMilliunits: 250_000,
      readyToAssignAfterMilliunits: 350_000,
      readyToAssignAfterVerified: false,
      verified: true,
      reconciledAfterWriteError: false,
    });
  });

  test("allows reducing an already-negative Ready to Assign balance", async () => {
    const client = new MemoryCategoryBudgetClient(makeMonth({ to_be_budgeted: -200_000 }));
    const service = new CategoryBudgetService(client, "budget-1");

    const result = await service.setAssigned("category-1", "2026-07-01", 50_000);

    expect(result.status).toBe("updated");
    expect(result.readyToAssignAfterMilliunits).toBe(-150_000);
  });

  test("blocks negative assigned totals unless explicitly allowed", async () => {
    const blockedClient = new MemoryCategoryBudgetClient(makeMonth());
    const blockedService = new CategoryBudgetService(blockedClient, "budget-1");

    await expect(blockedService.setAssigned("category-1", "2026-07-01", -10_000)).rejects.toThrow(
      "--allow-negative-assigned",
    );
    expect(blockedClient.updates).toEqual([]);

    const allowedClient = new MemoryCategoryBudgetClient(makeMonth());
    const allowedService = new CategoryBudgetService(allowedClient, "budget-1");
    const result = await allowedService.setAssigned("category-1", "2026-07-01", -10_000, {
      allowNegativeAssigned: true,
    });

    expect(result.status).toBe("updated");
  });
});
