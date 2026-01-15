import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { loadTestEnv } from "../helpers/testEnv";

const REQUIRED_BUDGET_ID = "06443689-ec9d-45d9-a37a-53dc60014769";

const { tokens, budgetId } = loadTestEnv();
const token = tokens[0];

type CliResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "src/cli/index.ts", ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

type TransactionListItem = {
  id: string;
  transfer_account_id?: string | null;
  transfer_transaction_id?: string | null;
  subtransactions?: unknown[];
};

type AccountListItem = {
  id: string;
  closed?: boolean;
  on_budget?: boolean;
};

type CategoryListItem = {
  id: string;
  name: string;
  hidden?: boolean;
  deleted?: boolean;
};

type TransactionDetail = {
  id: string;
  account_id?: string;
  category_id?: string | null;
  memo?: string | null;
  flag_color?: string | null;
};

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getWritableAccountId(env: NodeJS.ProcessEnv): Promise<string | null> {
  const result = await runCli(["account", "list", "--format", "json"], env);
  if (result.exitCode !== 0) {
    throw new Error(`account list failed: ${result.stderr}`);
  }
  const accounts = JSON.parse(result.stdout) as AccountListItem[];
  if (accounts.length === 0) return null;
  const candidate =
    accounts.find((account) => !account.closed && account.on_budget) ??
    accounts.find((account) => !account.closed) ??
    accounts[0];
  return candidate?.id ?? null;
}

async function getCategories(env: NodeJS.ProcessEnv): Promise<CategoryListItem[]> {
  const result = await runCli(["category", "list", "--format", "json"], env);
  if (result.exitCode !== 0) {
    throw new Error(`category list failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as CategoryListItem[];
}

function findUniqueCategory(categories: CategoryListItem[]): CategoryListItem | null {
  const usable = categories.filter((category) => !category.deleted && !category.hidden);
  const counts = new Map<string, number>();
  for (const category of usable) {
    const key = category.name.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (
    usable.find((category) => (counts.get(category.name.trim().toLowerCase()) ?? 0) === 1) ?? null
  );
}

function findDuplicateCategoryName(categories: CategoryListItem[]): string | null {
  const usable = categories.filter((category) => !category.deleted && !category.hidden);
  const counts = new Map<string, number>();
  for (const category of usable) {
    const key = category.name.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const category of usable) {
    if ((counts.get(category.name.trim().toLowerCase()) ?? 0) > 1) {
      return category.name;
    }
  }
  return null;
}

async function createTransaction(
  env: NodeJS.ProcessEnv,
  accountId: string,
  memo: string,
  options: {
    amount?: string;
    categoryId?: string;
    flagColor?: string;
    approved?: boolean;
  } = {},
): Promise<TransactionDetail> {
  const args = [
    "tx",
    "create",
    "--account-id",
    accountId,
    "--date",
    todayDate(),
    "--amount",
    options.amount ?? "-1",
    "--memo",
    memo,
    "--yes",
    "--format",
    "json",
  ];
  if (options.approved ?? true) {
    args.push("--approved");
  }
  if (options.categoryId) {
    args.push("--category-id", options.categoryId);
  }
  if (options.flagColor) {
    args.push("--flag-color", options.flagColor);
  }

  const result = await runCli(args, env);
  if (result.exitCode !== 0) {
    throw new Error(`tx create failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as TransactionDetail;
}

async function getTransaction(
  env: NodeJS.ProcessEnv,
  id: string,
): Promise<TransactionDetail | null> {
  const result = await runCli(["tx", "get", "--id", id, "--format", "json"], env);
  if (result.exitCode !== 0) return null;
  return JSON.parse(result.stdout) as TransactionDetail;
}

async function getWritableTransaction(env: NodeJS.ProcessEnv): Promise<TransactionListItem | null> {
  const listResult = await runCli(["tx", "list", "--format", "json"], env);
  if (listResult.exitCode !== 0) {
    throw new Error(`tx list failed: ${listResult.stderr}`);
  }
  const transactions = JSON.parse(listResult.stdout) as TransactionListItem[];
  if (transactions.length === 0) return null;

  const candidate =
    transactions.find((transaction) => {
      const hasSplits =
        Array.isArray(transaction.subtransactions) && transaction.subtransactions.length > 0;
      return !transaction.transfer_account_id && !transaction.transfer_transaction_id && !hasSplits;
    }) ?? transactions[0];

  return candidate ?? null;
}

if (!token || !budgetId) {
  test.skip("e2e: set NAB_TOKENS (or run `nab auth token add`) and NAB_BUDGET_ID to run", () => {});
} else if (budgetId !== REQUIRED_BUDGET_ID) {
  test("e2e: budget id must be the dedicated test budget", () => {
    throw new Error(
      `NAB_BUDGET_ID must be ${REQUIRED_BUDGET_ID} (got ${budgetId}). Refuse to run.`,
    );
  });
} else {
  const baseEnv = { ...process.env, NAB_TOKENS: tokens.join(","), NAB_BUDGET_ID: budgetId };

  test("e2e: budget list works without budget id", async () => {
    const { stdout, stderr, exitCode } = await runCli(["budget", "list", "--format", "json"], {
      ...baseEnv,
      NAB_BUDGET_ID: "",
    });

    expect(exitCode).toBe(0);
    expect(stderr.trim()).toBe("");

    const budgets = JSON.parse(stdout) as Array<{ id: string }>;
    expect(budgets.some((budget) => budget.id === REQUIRED_BUDGET_ID)).toBe(true);
  });

  test("e2e: tx get returns transaction json", async () => {
    const transaction = await getWritableTransaction(baseEnv);
    if (!transaction) return;
    const id = transaction.id;
    const { stdout, stderr, exitCode } = await runCli(
      ["tx", "get", "--id", id, "--format", "json"],
      baseEnv,
    );

    expect(exitCode).toBe(0);
    expect(stderr.trim()).toBe("");

    const parsed = JSON.parse(stdout) as { id: string };
    expect(parsed.id).toBe(id);
  });

  test("e2e: memo mutation applies and reverts", async () => {
    const transaction = await getWritableTransaction(baseEnv);
    if (!transaction) return;
    const id = transaction.id;

    const readResult = await runCli(["tx", "get", "--id", id, "--format", "json"], baseEnv);
    expect(readResult.exitCode).toBe(0);
    expect(readResult.stderr.trim()).toBe("");
    const current = JSON.parse(readResult.stdout) as { memo?: string | null };
    const originalMemo = current.memo ?? null;
    const testMemo = originalMemo === "__nab_e2e__" ? "__nab_e2e__2" : "__nab_e2e__";

    const setResult = await runCli(
      ["tx", "memo", "set", "--id", id, "--memo", testMemo, "--yes", "--format", "json"],
      baseEnv,
    );
    expect(setResult.exitCode).toBe(0);
    expect(setResult.stderr.trim()).toBe("");

    const memoResult = await runCli(["tx", "memo", "get", "--id", id, "--format", "json"], baseEnv);
    expect(memoResult.exitCode).toBe(0);
    expect(memoResult.stderr.trim()).toBe("");
    const memoParsed = JSON.parse(memoResult.stdout) as { memo?: string | null };
    expect(memoParsed.memo ?? null).toBe(testMemo);

    if (originalMemo) {
      const restore = await runCli(
        ["tx", "memo", "set", "--id", id, "--memo", originalMemo, "--yes", "--format", "json"],
        baseEnv,
      );
      expect(restore.exitCode).toBe(0);
      expect(restore.stderr.trim()).toBe("");
    } else {
      const restore = await runCli(
        ["tx", "memo", "clear", "--id", id, "--yes", "--format", "json"],
        baseEnv,
      );
      expect(restore.exitCode).toBe(0);
      expect(restore.stderr.trim()).toBe("");
    }

    const finalMemo = await runCli(["tx", "memo", "get", "--id", id, "--format", "json"], baseEnv);
    expect(finalMemo.exitCode).toBe(0);
    expect(finalMemo.stderr.trim()).toBe("");
    const finalParsed = JSON.parse(finalMemo.stdout) as { memo?: string | null };
    expect(finalParsed.memo ?? null).toBe(originalMemo);
  });

  test("e2e: history revert restores memo change", async () => {
    const accountId = await getWritableAccountId(baseEnv);
    if (!accountId) return;

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "nab-e2e-history-"));
    const env = { ...baseEnv, NAB_CONFIG_DIR: tempDir };

    const transaction = await createTransaction(env, accountId, "__nab_e2e_history__");
    const id = transaction.id;

    try {
      const original = await getTransaction(env, id);
      const originalMemo = original?.memo ?? null;
      const nextMemo =
        originalMemo === "__nab_e2e_history__2" ? "__nab_e2e_history__3" : "__nab_e2e_history__2";

      const setResult = await runCli(
        ["tx", "memo", "set", "--id", id, "--memo", nextMemo, "--yes", "--format", "json"],
        env,
      );
      expect(setResult.exitCode).toBe(0);

      const historyResult = await runCli(
        ["history", "list", "--limit", "5", "--format", "json"],
        env,
      );
      expect(historyResult.exitCode).toBe(0);

      const actions = JSON.parse(historyResult.stdout) as Array<{ id: string; actionType: string }>;
      const memoAction =
        actions.find((action) => action.actionType === "tx.memo.set") ?? actions[0];
      expect(memoAction?.id).toBeTruthy();

      const revertResult = await runCli(
        ["history", "revert", "--id", memoAction.id, "--yes", "--format", "json"],
        env,
      );
      expect(revertResult.exitCode).toBe(0);

      const after = await getTransaction(env, id);
      expect(after?.memo ?? null).toBe(originalMemo);
    } finally {
      await runCli(["tx", "delete", "--id", id, "--yes", "--format", "json"], env);
    }
  });

  test("e2e: tx delete respects --yes and dry-run", async () => {
    const accountId = await getWritableAccountId(baseEnv);
    if (!accountId) return;

    const transaction = await createTransaction(baseEnv, accountId, "__nab_e2e_delete__");
    const id = transaction.id;

    try {
      const missingYes = await runCli(["tx", "delete", "--id", id], baseEnv);
      expect(missingYes.exitCode).toBe(1);
      expect(missingYes.stderr).toContain("--yes");

      const stillThere = await runCli(["tx", "get", "--id", id, "--format", "json"], baseEnv);
      expect(stillThere.exitCode).toBe(0);

      const dryRun = await runCli(
        ["tx", "delete", "--id", id, "--dry-run", "--format", "json"],
        baseEnv,
      );
      expect(dryRun.exitCode).toBe(0);
      const dryParsed = JSON.parse(dryRun.stdout) as Array<{ status: string }>;
      expect(dryParsed[0]?.status).toBe("dry-run");

      const stillThereAfter = await runCli(["tx", "get", "--id", id, "--format", "json"], baseEnv);
      expect(stillThereAfter.exitCode).toBe(0);

      const deleted = await runCli(
        ["tx", "delete", "--id", id, "--yes", "--format", "json"],
        baseEnv,
      );
      expect(deleted.exitCode).toBe(0);

      const afterDelete = await runCli(["tx", "get", "--id", id, "--format", "json"], baseEnv);
      expect(afterDelete.exitCode).toBe(1);
    } finally {
      await runCli(["tx", "delete", "--id", id, "--yes", "--format", "json"], baseEnv);
    }
  });

  test("e2e: tx category set resolves by name", async () => {
    const accountId = await getWritableAccountId(baseEnv);
    if (!accountId) return;
    const categories = await getCategories(baseEnv);
    const uniqueCategory = findUniqueCategory(categories);
    if (!uniqueCategory) return;

    const transaction = await createTransaction(baseEnv, accountId, "__nab_e2e_category__");
    const id = transaction.id;

    try {
      const setResult = await runCli(
        [
          "tx",
          "category",
          "set",
          "--id",
          id,
          "--category-name",
          uniqueCategory.name,
          "--yes",
          "--format",
          "json",
        ],
        baseEnv,
      );
      expect(setResult.exitCode).toBe(0);

      const getResult = await runCli(["tx", "get", "--id", id, "--format", "json"], baseEnv);
      expect(getResult.exitCode).toBe(0);
      const parsed = JSON.parse(getResult.stdout) as TransactionDetail;
      expect(parsed.category_id).toBe(uniqueCategory.id);

      const clearResult = await runCli(
        ["tx", "category", "clear", "--id", id, "--yes", "--format", "json"],
        baseEnv,
      );
      expect(clearResult.exitCode).toBe(0);
    } finally {
      await runCli(["tx", "delete", "--id", id, "--yes", "--format", "json"], baseEnv);
    }
  });

  test("e2e: tx category set rejects ambiguous names when present", async () => {
    const accountId = await getWritableAccountId(baseEnv);
    if (!accountId) return;
    const categories = await getCategories(baseEnv);
    const duplicateName = findDuplicateCategoryName(categories);
    if (!duplicateName) return;

    const transaction = await createTransaction(baseEnv, accountId, "__nab_e2e_category_dup__");
    const id = transaction.id;

    try {
      const result = await runCli(
        [
          "tx",
          "category",
          "set",
          "--id",
          id,
          "--category-name",
          duplicateName,
          "--dry-run",
          "--format",
          "json",
        ],
        baseEnv,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Ambiguous match");
    } finally {
      await runCli(["tx", "delete", "--id", id, "--yes", "--format", "json"], baseEnv);
    }
  });

  test("e2e: tx memo set respects dry-run", async () => {
    const accountId = await getWritableAccountId(baseEnv);
    if (!accountId) return;

    const transaction = await createTransaction(baseEnv, accountId, "__nab_e2e_memo_dry__");
    const id = transaction.id;

    try {
      const dryRun = await runCli(
        ["tx", "memo", "set", "--id", id, "--memo", "dry-run", "--dry-run", "--format", "json"],
        baseEnv,
      );
      expect(dryRun.exitCode).toBe(0);

      const current = await getTransaction(baseEnv, id);
      expect(current?.memo ?? null).toBe("__nab_e2e_memo_dry__");
    } finally {
      await runCli(["tx", "delete", "--id", id, "--yes", "--format", "json"], baseEnv);
    }
  });

  test("e2e: tx memo clear respects dry-run", async () => {
    const accountId = await getWritableAccountId(baseEnv);
    if (!accountId) return;

    const transaction = await createTransaction(baseEnv, accountId, "__nab_e2e_memo_clear__");
    const id = transaction.id;

    try {
      const dryRun = await runCli(
        ["tx", "memo", "clear", "--id", id, "--dry-run", "--format", "json"],
        baseEnv,
      );
      expect(dryRun.exitCode).toBe(0);

      const current = await getTransaction(baseEnv, id);
      expect(current?.memo ?? null).toBe("__nab_e2e_memo_clear__");
    } finally {
      await runCli(["tx", "delete", "--id", id, "--yes", "--format", "json"], baseEnv);
    }
  });

  test("e2e: tx category clear respects dry-run", async () => {
    const accountId = await getWritableAccountId(baseEnv);
    if (!accountId) return;
    const categories = await getCategories(baseEnv);
    const uniqueCategory = findUniqueCategory(categories);
    if (!uniqueCategory) return;

    const transaction = await createTransaction(baseEnv, accountId, "__nab_e2e_cat_clear__", {
      categoryId: uniqueCategory.id,
    });
    const id = transaction.id;

    try {
      const dryRun = await runCli(
        ["tx", "category", "clear", "--id", id, "--dry-run", "--format", "json"],
        baseEnv,
      );
      expect(dryRun.exitCode).toBe(0);

      const current = await getTransaction(baseEnv, id);
      expect(current?.category_id).toBe(uniqueCategory.id);
    } finally {
      await runCli(["tx", "delete", "--id", id, "--yes", "--format", "json"], baseEnv);
    }
  });

  test("e2e: tx flag clear respects dry-run", async () => {
    const accountId = await getWritableAccountId(baseEnv);
    if (!accountId) return;

    const transaction = await createTransaction(baseEnv, accountId, "__nab_e2e_flag_clear__", {
      flagColor: "red",
    });
    const id = transaction.id;

    try {
      const dryRun = await runCli(
        ["tx", "flag", "clear", "--id", id, "--dry-run", "--format", "json"],
        baseEnv,
      );
      expect(dryRun.exitCode).toBe(0);

      const current = await getTransaction(baseEnv, id);
      expect(current?.flag_color ?? null).toBe("red");
    } finally {
      await runCli(["tx", "delete", "--id", id, "--yes", "--format", "json"], baseEnv);
    }
  });

  test("e2e: tx amount set requires single id", async () => {
    const accountId = await getWritableAccountId(baseEnv);
    if (!accountId) return;

    const first = await createTransaction(baseEnv, accountId, "__nab_e2e_amt_1__");
    const second = await createTransaction(baseEnv, accountId, "__nab_e2e_amt_2__");

    try {
      const result = await runCli(
        [
          "tx",
          "amount",
          "set",
          "--id",
          first.id,
          "--id",
          second.id,
          "--amount",
          "-2.00",
          "--dry-run",
        ],
        baseEnv,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("exactly one");
    } finally {
      await runCli(["tx", "delete", "--id", first.id, "--yes", "--format", "json"], baseEnv);
      await runCli(["tx", "delete", "--id", second.id, "--yes", "--format", "json"], baseEnv);
    }
  });

  test("e2e: tx account set moves transaction between accounts", async () => {
    const accountId = await getWritableAccountId(baseEnv);
    if (!accountId) return;
    const result = await runCli(["account", "list", "--format", "json"], baseEnv);
    if (result.exitCode !== 0) return;
    const accounts = JSON.parse(result.stdout) as AccountListItem[];
    const alt =
      accounts.find(
        (account) => account.id !== accountId && !account.closed && account.on_budget,
      ) ??
      accounts.find((account) => account.id !== accountId && !account.closed) ??
      null;
    if (!alt) return;

    const transaction = await createTransaction(baseEnv, accountId, "__nab_e2e_account_set__");
    const id = transaction.id;

    try {
      const setResult = await runCli(
        ["tx", "account", "set", "--id", id, "--account-id", alt.id, "--yes", "--format", "json"],
        baseEnv,
      );
      expect(setResult.exitCode).toBe(0);

      const current = await getTransaction(baseEnv, id);
      expect(current?.account_id).toBe(alt.id);
    } finally {
      await runCli(["tx", "delete", "--id", id, "--yes", "--format", "json"], baseEnv);
    }
  });

  test("e2e: tx memo set rejects empty ids", async () => {
    const result = await runCli(
      ["tx", "memo", "set", "--id", "", "--memo", "noop", "--dry-run"],
      baseEnv,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("non-empty --id");
  });
}
