import yargs from "yargs/yargs";

import { accountCommand } from "./commands/account";
import { budgetCommand } from "./commands/budget";
import { cacheCommand } from "./commands/cache";
import { categoryCommand } from "./commands/category";
import { configCommand } from "./commands/config";
import { historyCommand } from "./commands/history";
import { payeeCommand } from "./commands/payee";
import { txCommand } from "./commands/tx";
import { ExitCode } from "@/util/exitCodes";
import { formatError } from "@/util/errors";

export function createCli(argv: string[]) {
  const cli = yargs(argv)
    .scriptName("ynac")
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
    .fail((msg, err, y) => {
      const error = err ?? new Error(msg);
      const exitCode = msg ? ExitCode.Usage : ExitCode.Software;

      // Errors to stderr; keep stdout clean for piping.
      process.stderr.write(`${formatError(error)}\n`);

      // Show help for usage errors in interactive terminals.
      if (exitCode === ExitCode.Usage && process.stderr.isTTY) {
        y.showHelp("error");
      }

      process.exit(exitCode);
    })
    .command(budgetCommand)
    .command(accountCommand)
    .command(categoryCommand)
    .command(payeeCommand)
    .command(configCommand)
    .command(txCommand)
    .command(cacheCommand)
    .command(historyCommand)
    .demandCommand(1, "Specify a command")
    .middleware([], true)
    .showHelpOnFail(false);

  return cli;
}

function cliTerminalWidth(): number {
  // yargs.terminalWidth() is only available on the yargs instance.
  // This keeps the scaffold simple.
  return process.stdout.isTTY ? process.stdout.columns ?? 120 : 120;
}
