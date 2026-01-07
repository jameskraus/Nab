import yargs from "yargs/yargs";

import { createAppContext } from "@/app/createAppContext";
import { formatError } from "@/util/errors";
import { exitCodeForError } from "@/util/exitCodes";
import type { Argv } from "yargs";
import { accountCommand } from "./commands/account";
import { authCommand } from "./commands/auth";
import { budgetCommand } from "./commands/budget";
import { categoryCommand } from "./commands/category";
import { configCommand } from "./commands/config";
import { historyCommand } from "./commands/history";
import { payeeCommand } from "./commands/payee";
import { txCommand } from "./commands/tx";
import type { CliGlobalArgs } from "./types";

export function createCli(argv: string[]) {
  const cli = (yargs(argv) as Argv<CliGlobalArgs>)
    .scriptName("nab")
    .usage("$0 <command> [options]")
    .help()
    .alias("h", "help")
    .version("0.1.0")
    .alias("v", "version")
    .strict()
    .recommendCommands()
    .wrap(Math.min(120, cliTerminalWidth()))
    .option("budget-id", {
      type: "string",
      describe: "Default budget id to operate on (overrides config)",
    })
    .option("format", {
      type: "string",
      describe: "Output format",
      choices: ["table", "json", "tsv", "ids"] as const,
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
    .group(
      ["budget-id", "format", "quiet", "no-color", "dry-run", "yes", "help", "version"],
      "Global Options",
    )
    .check((argv) => {
      if (typeof argv["budget-id"] === "string" && argv["budget-id"].trim().length === 0) {
        throw new Error("Provide a non-empty --budget-id value.");
      }
      return true;
    })
    .middleware(async (argv) => {
      const command = String(argv._[0] ?? "");
      const subcommand = String(argv._[1] ?? "");
      if (!command) return;
      if (command === "auth") return;
      if (command === "config") return;
      if (command === "history") {
        (argv as { appContext?: unknown }).appContext = await createAppContext({
          argv: argv as { "budget-id"?: string; budgetId?: string },
          requireToken: false,
          requireBudgetId: false,
          createDb: true,
        });
        return;
      }
      const isBudgetList = command === "budget" && subcommand === "list";
      const isBudgetCurrent = command === "budget" && subcommand === "current";
      const isReadOnlyList =
        (command === "account" || command === "category" || command === "payee") &&
        subcommand === "list";
      const isTxReadOnly = command === "tx" && (subcommand === "list" || subcommand === "get");

      const requireToken = !isBudgetCurrent;
      const requireBudgetId = !(isBudgetList || isBudgetCurrent);
      const createDb = !(isBudgetList || isBudgetCurrent || isReadOnlyList || isTxReadOnly);

      // Attach for future handlers; throws on missing auth context.
      (argv as { appContext?: unknown }).appContext = await createAppContext({
        argv: argv as { "budget-id"?: string; budgetId?: string },
        requireToken,
        requireBudgetId,
        createDb,
      });
    })
    .fail((msg, err, y) => {
      if (!err && msg === "Specify a command") {
        y.showHelp("log");
        process.exit(0);
      }
      const error = err ?? new Error(msg);
      const exitCode = exitCodeForError(error);

      // Errors to stderr; keep stdout clean for piping.
      process.stderr.write(`${formatError(error)}\n`);

      // Show help for usage errors in interactive terminals.
      if (msg && process.stderr.isTTY) {
        y.showHelp("error");
      }

      process.exit(exitCode);
    })
    .command(budgetCommand)
    .command(accountCommand)
    .command(categoryCommand)
    .command(payeeCommand)
    .command(authCommand)
    .command(configCommand)
    .command(txCommand)
    .command(historyCommand)
    .demandCommand(1, "Specify a command")
    .middleware([], true)
    .showHelpOnFail(false);

  return cli;
}

function cliTerminalWidth(): number {
  // yargs.terminalWidth() is only available on the yargs instance.
  // This keeps the scaffold simple.
  return process.stdout.isTTY ? (process.stdout.columns ?? 120) : 120;
}
