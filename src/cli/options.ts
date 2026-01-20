import type { Argv } from "yargs";

export const outputFormats = ["table", "json", "tsv", "ids"] as const;
export type OutputFormatOption = (typeof outputFormats)[number];

export type OutputArgs = {
  format: OutputFormatOption;
  quiet: boolean;
  noColor: boolean;
};

export type AuthArgs = {
  auth?: "pat" | "oauth";
};

export type BudgetArgs = {
  budgetId?: string;
};

export type MutationArgs = {
  dryRun: boolean;
  yes: boolean;
};

export function withOutputOptions<T>(y: Argv<T>): Argv<T & OutputArgs> {
  return y
    .option("format", {
      type: "string",
      describe: "Output format",
      choices: outputFormats,
      default: "table",
    })
    .option("quiet", {
      type: "boolean",
      default: false,
      describe: "Suppress non-essential output",
    })
    .option("no-color", {
      type: "boolean",
      default: false,
      describe: "Disable ANSI colors",
    })
    .group(["format", "quiet", "no-color"], "Output Options") as unknown as Argv<T & OutputArgs>;
}

export function withAuthOptions<T>(y: Argv<T>): Argv<T & AuthArgs> {
  return y
    .option("auth", {
      type: "string",
      choices: ["pat", "oauth"] as const,
      describe: "Preferred auth method",
    })
    .group(["auth"], "Auth Options") as Argv<T & AuthArgs>;
}

export function withBudgetOptions<T>(y: Argv<T>): Argv<T & BudgetArgs> {
  return y
    .option("budget-id", {
      type: "string",
      describe: "Default budget id to operate on (overrides config)",
    })
    .check((argv) => {
      if (typeof (argv as { budgetId?: string }).budgetId === "string") {
        const value = (argv as { budgetId?: string }).budgetId ?? "";
        if (value.trim().length === 0) {
          throw new Error("Provide a non-empty --budget-id value.");
        }
      }
      return true;
    })
    .group(["budget-id"], "Budget Options") as Argv<T & BudgetArgs>;
}

export function withMutationOptions<T>(y: Argv<T>): Argv<T & MutationArgs> {
  return y
    .option("dry-run", {
      type: "boolean",
      default: false,
      describe: "Preview changes without applying mutations",
    })
    .option("yes", {
      type: "boolean",
      default: false,
      describe: "Skip interactive confirmation prompts",
    })
    .group(["dry-run", "yes"], "Mutation Options") as unknown as Argv<T & MutationArgs>;
}
