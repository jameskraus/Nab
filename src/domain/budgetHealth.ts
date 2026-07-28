export type BudgetHealthCategoryIssue = "overspent" | "target_shortfall" | "zero_assigned_target";

export type BudgetHealthReadyToAssignIssue = "over_assigned";

export type BudgetHealthReadyToAssignState =
  | "over_assigned"
  | "available_to_assign"
  | "fully_assigned";

export type BudgetHealthCategoryInput = {
  id: string;
  category_group_id: string;
  category_group_name?: string;
  name: string;
  hidden?: boolean;
  internal?: boolean;
  budgeted: number;
  activity: number;
  balance: number;
  goal_type?: string | null;
  goal_target?: number | null;
  goal_target_date?: string | null;
  goal_target_month?: string | null;
  goal_percentage_complete?: number | null;
  goal_under_funded?: number | null;
  deleted: boolean;
};

export type BudgetHealthMonthInput = {
  month: string;
  income: number;
  budgeted: number;
  activity: number;
  to_be_budgeted: number;
  categories: ReadonlyArray<BudgetHealthCategoryInput>;
};

export type BudgetHealthCategory = {
  id: string;
  categoryGroupId: string;
  categoryGroupName: string;
  name: string;
  hidden: boolean;
  internal?: boolean;
  assignedMilliunits: number;
  activityMilliunits: number;
  availableMilliunits: number;
  targetType: string | null;
  targetMilliunits: number | null;
  targetDate: string | null;
  targetPercentageComplete: number | null;
  targetShortfallMilliunits: number;
  issues: BudgetHealthCategoryIssue[];
};

export type BudgetHealthSummary = {
  month: string;
  totals: {
    incomeMilliunits: number;
    assignedMilliunits: number;
    activityMilliunits: number;
    readyToAssignMilliunits: number;
  };
  readyToAssign: {
    amountMilliunits: number;
    state: BudgetHealthReadyToAssignState;
    issues: BudgetHealthReadyToAssignIssue[];
  };
  counts: {
    categories: number;
    overspent: number;
    targetShortfall: number;
    zeroAssignedTarget: number;
  };
  deficits: {
    overspentMilliunits: number;
    targetShortfallMilliunits: number;
  };
  categories: BudgetHealthCategory[];
};

export type BuildBudgetHealthSummaryOptions = {
  includeHealthy?: boolean;
};

const CATEGORY_ISSUE_ORDER: ReadonlyArray<BudgetHealthCategoryIssue> = [
  "overspent",
  "target_shortfall",
  "zero_assigned_target",
];

function categoryIssues(category: BudgetHealthCategoryInput): BudgetHealthCategoryIssue[] {
  const issues = new Set<BudgetHealthCategoryIssue>();
  const targetShortfall = (category.goal_under_funded ?? 0) > 0;

  if (category.balance < 0) issues.add("overspent");
  if (targetShortfall) issues.add("target_shortfall");
  if (category.budgeted === 0 && targetShortfall) issues.add("zero_assigned_target");

  return CATEGORY_ISSUE_ORDER.filter((issue) => issues.has(issue));
}

function categorySeverity(category: BudgetHealthCategory): number {
  if (category.issues.includes("overspent")) return 0;
  if (category.issues.includes("zero_assigned_target")) return 1;
  if (category.issues.includes("target_shortfall")) return 2;
  return 3;
}

function compareCategories(a: BudgetHealthCategory, b: BudgetHealthCategory): number {
  return (
    categorySeverity(a) - categorySeverity(b) ||
    a.categoryGroupName.localeCompare(b.categoryGroupName) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

function readyToAssignState(amount: number): BudgetHealthReadyToAssignState {
  if (amount < 0) return "over_assigned";
  if (amount > 0) return "available_to_assign";
  return "fully_assigned";
}

function toBudgetHealthCategory(category: BudgetHealthCategoryInput): BudgetHealthCategory {
  return {
    id: category.id,
    categoryGroupId: category.category_group_id,
    categoryGroupName: category.category_group_name ?? "",
    name: category.name,
    hidden: category.hidden ?? false,
    ...(category.internal === undefined ? {} : { internal: category.internal }),
    assignedMilliunits: category.budgeted,
    activityMilliunits: category.activity,
    availableMilliunits: category.balance,
    targetType: category.goal_type ?? null,
    targetMilliunits: category.goal_target ?? null,
    targetDate: category.goal_target_date ?? category.goal_target_month ?? null,
    targetPercentageComplete: category.goal_percentage_complete ?? null,
    targetShortfallMilliunits: category.goal_under_funded ?? 0,
    issues: categoryIssues(category),
  };
}

function shouldIncludeCategory(category: BudgetHealthCategory, includeHealthy: boolean): boolean {
  if (includeHealthy) return true;
  if (category.internal === true) return false;
  if (category.issues.length === 0) return false;

  const hasOverspending = category.issues.includes("overspent");
  if (category.hidden && !hasOverspending) return false;

  return true;
}

export function buildBudgetHealthSummary(
  month: BudgetHealthMonthInput,
  options: BuildBudgetHealthSummaryOptions = {},
): BudgetHealthSummary {
  const includeHealthy = options.includeHealthy ?? false;
  const readyToAssignIssues: BudgetHealthReadyToAssignIssue[] =
    month.to_be_budgeted < 0 ? ["over_assigned"] : [];

  const categories = month.categories
    .filter((category) => !category.deleted)
    .map(toBudgetHealthCategory)
    .filter((category) => shouldIncludeCategory(category, includeHealthy))
    .sort(compareCategories);
  const overspentCategories = categories.filter((category) =>
    category.issues.includes("overspent"),
  );
  const targetShortfallCategories = categories.filter((category) =>
    category.issues.includes("target_shortfall"),
  );

  return {
    month: month.month,
    totals: {
      incomeMilliunits: month.income,
      assignedMilliunits: month.budgeted,
      activityMilliunits: month.activity,
      readyToAssignMilliunits: month.to_be_budgeted,
    },
    readyToAssign: {
      amountMilliunits: month.to_be_budgeted,
      state: readyToAssignState(month.to_be_budgeted),
      issues: readyToAssignIssues,
    },
    counts: {
      categories: categories.length,
      overspent: overspentCategories.length,
      targetShortfall: targetShortfallCategories.length,
      zeroAssignedTarget: categories.filter((category) =>
        category.issues.includes("zero_assigned_target"),
      ).length,
    },
    deficits: {
      overspentMilliunits: overspentCategories.reduce(
        (total, category) => total + Math.abs(category.availableMilliunits),
        0,
      ),
      targetShortfallMilliunits: targetShortfallCategories.reduce(
        (total, category) => total + category.targetShortfallMilliunits,
        0,
      ),
    },
    categories,
  };
}
