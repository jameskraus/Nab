import { Writable } from "node:stream";

import { expect, test } from "bun:test";

import {
  type BudgetStatusOutput,
  parseBudgetMonth,
  writeBudgetStatus,
} from "@/cli/commands/budgetStatus";
import {
  type CategoryAssignmentOutput,
  parseAssignmentMonth,
  writeCategoryAssignment,
} from "@/cli/commands/categoryAssigned";
import {
  type TransactionReviewOutput,
  writeTransactionReview,
} from "@/cli/commands/reviewTransactions";

function createCapture() {
  let data = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  return { stream, output: () => data };
}

function transactionReviewOutput(): TransactionReviewOutput {
  return {
    schema_version: 1,
    scope: {
      since_date: "2026-07-01",
      account_name_prefixes: ["J "],
      limit: 5,
    },
    counts: {
      total: 2,
      returned: 1,
      unapproved: 2,
      uncategorized: 1,
      both: 1,
    },
    has_more: true,
    items: [
      {
        id: "transaction-1",
        ref: "A1",
        date: "2026-07-02",
        account_id: "account-1",
        account_name: "J Checking",
        payee_id: "payee-1",
        payee_name: "Market",
        import_payee_name: "MARKET 123",
        import_payee_name_original: "MARKET 123",
        category_id: null,
        category_name: null,
        memo: null,
        import_id: null,
        amount: "-$12.34",
        amount_display: "-$12.34",
        raw_amount: -12_340,
        approved: false,
        cleared: "cleared",
        kind: "regular",
        issues: ["unapproved", "uncategorized"],
        transfer_account_id: null,
        transfer_transaction_id: null,
        split_subtransaction_count: 0,
        split_uncategorized_subtransaction_count: 0,
        split_limitation: null,
      },
    ],
  };
}

function money(amount: string, rawAmount: number) {
  return { amount, amount_display: amount, raw_amount: rawAmount };
}

function budgetStatusOutput(): BudgetStatusOutput {
  return {
    schema_version: 1,
    budget_id: "budget-1",
    month: "2026-07-01",
    totals: {
      income: money("$4,000.00", 4_000_000),
      assigned: money("$3,500.00", 3_500_000),
      activity: money("-$2,000.00", -2_000_000),
      ready_to_assign: money("$500.00", 500_000),
    },
    ready_to_assign: {
      state: "available_to_assign",
      issues: [],
      value: money("$500.00", 500_000),
    },
    counts: {
      returned: 1,
      overspent: 1,
      target_shortfall: 1,
      zero_assigned_target: 1,
    },
    deficits: {
      overspent: money("$10.00", 10_000),
      target_shortfall: money("$25.00", 25_000),
    },
    categories: [
      {
        id: "category-1",
        category_group_id: "group-1",
        category_group_name: "Bills",
        name: "Electricity",
        hidden: false,
        internal: false,
        assigned: money("$0.00", 0),
        activity: money("-$10.00", -10_000),
        available: money("-$10.00", -10_000),
        target_type: "NEED",
        target: money("$100.00", 100_000),
        target_date: "2026-07-31",
        target_percentage_complete: 0,
        target_shortfall: money("$25.00", 25_000),
        issues: ["overspent", "target_shortfall", "zero_assigned_target"],
      },
    ],
  };
}

function assignmentOutput(): CategoryAssignmentOutput {
  return {
    id: "category-1",
    category: "Electricity",
    month: "2026-07-01",
    status: "dry-run",
    previous_assigned: "$0.00",
    previous_assigned_display: "$0.00",
    raw_previous_assigned: 0,
    assigned: "$25.00",
    assigned_display: "$25.00",
    raw_assigned: 25_000,
    delta: "$25.00",
    delta_display: "$25.00",
    raw_delta: 25_000,
    ready_to_assign_guard_month: "2026-08-01",
    ready_to_assign_before: "$500.00",
    ready_to_assign_before_display: "$500.00",
    raw_ready_to_assign_before: 500_000,
    ready_to_assign_projected: "$475.00",
    ready_to_assign_projected_display: "$475.00",
    raw_ready_to_assign_projected: 475_000,
    ready_to_assign_after_month: "2026-08-01",
    ready_to_assign_after: "$475.00",
    ready_to_assign_after_display: "$475.00",
    raw_ready_to_assign_after: 475_000,
    ready_to_assign_after_verified: false,
    would_over_assign: false,
    verified: false,
    reconciled_after_write_error: false,
  };
}

test("transaction review JSON is a versioned envelope and ids are transaction-only", () => {
  const jsonCapture = createCapture();
  writeTransactionReview(transactionReviewOutput(), "json", { stdout: jsonCapture.stream });
  const parsed = JSON.parse(jsonCapture.output()) as TransactionReviewOutput;
  expect(parsed.schema_version).toBe(1);
  expect(parsed.counts.total).toBe(2);
  expect(parsed.items[0]?.issues).toEqual(["unapproved", "uncategorized"]);

  const idsCapture = createCapture();
  writeTransactionReview(transactionReviewOutput(), "ids", { stdout: idsCapture.stream });
  expect(idsCapture.output()).toBe("transaction-1\n");
});

test("budget status JSON keeps resolved month and ids are category-only", () => {
  const jsonCapture = createCapture();
  writeBudgetStatus(budgetStatusOutput(), "json", { stdout: jsonCapture.stream });
  const parsed = JSON.parse(jsonCapture.output()) as BudgetStatusOutput;
  expect(parsed.month).toBe("2026-07-01");
  expect(parsed.ready_to_assign.value.raw_amount).toBe(500_000);
  expect(parsed.categories[0]?.issues).toContain("overspent");

  const idsCapture = createCapture();
  writeBudgetStatus(budgetStatusOutput(), "ids", { stdout: idsCapture.stream });
  expect(idsCapture.output()).toBe("category-1\n");
});

test("budget status accepts current or an exact first-of-month date", () => {
  expect(parseBudgetMonth("CURRENT")).toBe("current");
  expect(parseBudgetMonth("2026-07-01")).toBe("2026-07-01");
  expect(() => parseBudgetMonth("2026-07-02")).toThrow("first day of a month");
});

test("category assignment requires an exact first-of-month date", () => {
  expect(parseAssignmentMonth("2026-07-01")).toBe("2026-07-01");
  expect(() => parseAssignmentMonth("current")).toThrow("YYYY-MM-DD");
  expect(() => parseAssignmentMonth("2026-07-02")).toThrow("first day of a month");
});

test("category assignment writes a single category id", () => {
  const capture = createCapture();
  writeCategoryAssignment(assignmentOutput(), "ids", { stdout: capture.stream });
  expect(capture.output()).toBe("category-1\n");
});
