import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

async function runReview(args: string[]) {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "nab-review-parser-"));
  try {
    const proc = Bun.spawn(
      ["bun", "--no-env-file", "src/cli/index.ts", "review", "transactions", ...args],
      {
        env: {
          ...process.env,
          NAB_CONFIG_DIR: configDir,
          NAB_TOKENS: "",
          NAB_BUDGET_ID: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

test("review transactions recognizes the required dashed since-date option", async () => {
  const result = await runReview([
    "--since-date",
    "2026-07-01",
    "--limit",
    "0",
    "--format",
    "json",
  ]);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Missing auth");
  expect(result.stderr).not.toContain("Missing required argument");
});

test("review transactions validates date, prefix, and limit after recognizing since-date", async () => {
  const invalidDate = await runReview(["--since-date", "2026-02-30"]);
  expect(invalidDate.stderr).toContain("valid calendar date");

  const invalidPrefix = await runReview([
    "--since-date",
    "2026-07-01",
    "--account-name-prefix",
    "   ",
  ]);
  expect(invalidPrefix.stderr).toContain("--account-name-prefix must be non-empty");

  const invalidLimit = await runReview(["--since-date", "2026-07-01", "--limit", "501"]);
  expect(invalidLimit.stderr).toContain("--limit must be a whole number from 0 to 500");
});
