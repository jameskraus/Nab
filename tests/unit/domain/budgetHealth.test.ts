import { describe, expect, test } from "bun:test";

import {
  type BudgetHealthCategoryInput,
  type BudgetHealthMonthInput,
  buildBudgetHealthSummary,
} from "@/domain/budgetHealth";

function category(overrides: Partial<BudgetHealthCategoryInput> = {}): BudgetHealthCategoryInput {
  return {
    id: "category-1",
    category_group_id: "group-1",
    category_group_name: "Bills",
    name: "Electricity",
    hidden: false,
    budgeted: 0,
    activity: 0,
    balance: 0,
    goal_under_funded: 0,
    deleted: false,
    ...overrides,
  };
}

function month(
  categories: BudgetHealthCategoryInput[] = [],
  overrides: Partial<BudgetHealthMonthInput> = {},
): BudgetHealthMonthInput {
  return {
    month: "2026-07-01",
    income: 4_000_000,
    budgeted: 3_500_000,
    activity: -2_000_000,
    to_be_budgeted: 500_000,
    categories,
    ...overrides,
  };
}

describe("buildBudgetHealthSummary", () => {
  test("returns resolved month totals and over-assigned Ready to Assign state", () => {
    const summary = buildBudgetHealthSummary(month([], { to_be_budgeted: -25_000 }));

    expect(summary).toEqual({
      month: "2026-07-01",
      totals: {
        incomeMilliunits: 4_000_000,
        assignedMilliunits: 3_500_000,
        activityMilliunits: -2_000_000,
        readyToAssignMilliunits: -25_000,
      },
      readyToAssign: {
        amountMilliunits: -25_000,
        state: "over_assigned",
        issues: ["over_assigned"],
      },
      counts: {
        categories: 0,
        overspent: 0,
        targetShortfall: 0,
        zeroAssignedTarget: 0,
      },
      deficits: {
        overspentMilliunits: 0,
        targetShortfallMilliunits: 0,
      },
      categories: [],
    });
  });

  test.each([
    { amount: 1, state: "available_to_assign" },
    { amount: 0, state: "fully_assigned" },
  ] as const)("classifies Ready to Assign amount $amount as $state", ({ amount, state }) => {
    const summary = buildBudgetHealthSummary(month([], { to_be_budgeted: amount }));

    expect(summary.readyToAssign).toEqual({
      amountMilliunits: amount,
      state,
      issues: [],
    });
  });

  test("emits one category row with ordered issues when conditions overlap", () => {
    const summary = buildBudgetHealthSummary(
      month([
        category({
          id: "overlap",
          budgeted: 0,
          balance: -10_000,
          goal_under_funded: 25_000,
        }),
      ]),
    );

    expect(summary.categories).toHaveLength(1);
    expect(summary.categories[0]).toMatchObject({
      id: "overlap",
      assignedMilliunits: 0,
      availableMilliunits: -10_000,
      targetShortfallMilliunits: 25_000,
      issues: ["overspent", "target_shortfall", "zero_assigned_target"],
    });
    expect(summary.counts).toEqual({
      categories: 1,
      overspent: 1,
      targetShortfall: 1,
      zeroAssignedTarget: 1,
    });
    expect(summary.deficits).toEqual({
      overspentMilliunits: 10_000,
      targetShortfallMilliunits: 25_000,
    });
  });

  test("uses goal_under_funded as the target-shortfall authority", () => {
    const summary = buildBudgetHealthSummary(
      month([
        category({
          id: "rollover-satisfies-target",
          budgeted: 0,
          balance: 100_000,
          goal_target: 100_000,
          goal_under_funded: 0,
        }),
        category({
          id: "assigned-with-shortfall",
          budgeted: 50_000,
          goal_target: 100_000,
          goal_under_funded: 25_000,
        }),
        category({
          id: "target-math-is-not-authoritative",
          budgeted: 10_000,
          goal_target: 100_000,
          goal_under_funded: null,
        }),
      ]),
    );

    expect(summary.categories.map(({ id, issues }) => ({ id, issues }))).toEqual([
      {
        id: "assigned-with-shortfall",
        issues: ["target_shortfall"],
      },
    ]);
  });

  test("does not flag zero assigned without a native target shortfall", () => {
    const summary = buildBudgetHealthSummary(
      month([
        category({
          id: "zero-assigned",
          budgeted: 0,
          balance: 50_000,
          goal_type: "NEED",
          goal_under_funded: 0,
        }),
      ]),
    );

    expect(summary.categories).toEqual([]);
  });

  test("prefers the current target date and falls back to the deprecated target month", () => {
    const summary = buildBudgetHealthSummary(
      month([
        category({
          id: "current-date",
          goal_target_date: "2026-07-31",
          goal_target_month: "2026-07-01",
        }),
        category({
          id: "legacy-month",
          goal_target_month: "2026-08-01",
        }),
      ]),
      { includeHealthy: true },
    );

    expect(summary.categories.map(({ id, targetDate }) => ({ id, targetDate }))).toEqual([
      { id: "current-date", targetDate: "2026-07-31" },
      { id: "legacy-month", targetDate: "2026-08-01" },
    ]);
  });

  test("excludes deleted categories even when healthy categories are requested", () => {
    const summary = buildBudgetHealthSummary(
      month([
        category({ id: "deleted-overspent", balance: -10_000, deleted: true }),
        category({ id: "active-healthy", name: "Active", deleted: false }),
      ]),
      { includeHealthy: true },
    );

    expect(summary.categories.map((item) => item.id)).toEqual(["active-healthy"]);
  });

  test("suppresses hidden target-only attention but retains hidden overspending", () => {
    const summary = buildBudgetHealthSummary(
      month([
        category({
          id: "hidden-target",
          hidden: true,
          goal_under_funded: 10_000,
        }),
        category({
          id: "hidden-overspent",
          hidden: true,
          balance: -5_000,
          goal_under_funded: 10_000,
        }),
      ]),
    );

    expect(summary.categories.map(({ id, issues }) => ({ id, issues }))).toEqual([
      {
        id: "hidden-overspent",
        issues: ["overspent", "target_shortfall", "zero_assigned_target"],
      },
    ]);
  });

  test("suppresses internal categories from the default attention queue", () => {
    const summary = buildBudgetHealthSummary(
      month([
        category({
          id: "internal-overspent",
          internal: true,
          balance: -10_000,
          goal_under_funded: 10_000,
        }),
      ]),
    );

    expect(summary.categories).toEqual([]);
  });

  test("includeHealthy includes every active category and preserves optional internal state", () => {
    const summary = buildBudgetHealthSummary(
      month([
        category({
          id: "visible",
          category_group_name: undefined,
          internal: false,
        }),
        category({
          id: "hidden-target",
          name: "Hidden target",
          hidden: true,
          internal: true,
          goal_under_funded: 10_000,
        }),
        category({
          id: "internal-unspecified",
          name: "Internal-looking name",
          category_group_name: "Internal Master Category",
        }),
      ]),
      { includeHealthy: true },
    );

    expect(
      summary.categories.map(({ id, hidden, internal }) => ({ id, hidden, internal })),
    ).toEqual([
      { id: "hidden-target", hidden: true, internal: true },
      { id: "visible", hidden: false, internal: false },
      { id: "internal-unspecified", hidden: false, internal: undefined },
    ]);
    expect(summary.categories[1]?.categoryGroupName).toBe("");
  });

  test("sorts by severity, then group, name, and id", () => {
    const summary = buildBudgetHealthSummary(
      month([
        category({
          id: "healthy",
          category_group_name: "A Group",
          name: "Healthy",
        }),
        category({
          id: "target-z",
          category_group_name: "Z Group",
          name: "Target",
          budgeted: 1,
          goal_under_funded: 1,
        }),
        category({
          id: "zero-target",
          category_group_name: "Z Group",
          name: "Zero target",
          goal_under_funded: 1,
        }),
        category({
          id: "overspent-z",
          category_group_name: "Z Group",
          name: "Same",
          balance: -1,
        }),
        category({
          id: "overspent-b",
          category_group_name: "A Group",
          name: "Same",
          balance: -1,
        }),
        category({
          id: "overspent-a",
          category_group_name: "A Group",
          name: "Same",
          balance: -1,
        }),
      ]),
      { includeHealthy: true },
    );

    expect(summary.categories.map((item) => item.id)).toEqual([
      "overspent-a",
      "overspent-b",
      "overspent-z",
      "zero-target",
      "target-z",
      "healthy",
    ]);
  });
});
