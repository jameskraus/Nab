import yargs from "yargs/yargs";

import { formatError } from "@/util/errors";
import { exitCodeForError } from "@/util/exitCodes";
import type { Logger } from "pino";
import type { Argv } from "yargs";
import { accountCommand } from "./commands/account";
import { authCommand } from "./commands/auth";
import { budgetCommand } from "./commands/budget";
import { categoryCommand } from "./commands/category";
import { fixCommand } from "./commands/fix";
import { historyCommand } from "./commands/history";
import { payeeCommand } from "./commands/payee";
import { reviewCommand } from "./commands/review";
import { txCommand } from "./commands/tx";

type CliOptions = {
  logger: Logger;
};

export function createCli(argv: string[], options: CliOptions) {
  const baseLogger = options.logger;

  const cli = (yargs(argv) as Argv)
    .scriptName("nab")
    .usage("$0 <command> [options]")
    .help()
    .alias("h", "help")
    .version("0.1.0")
    .alias("v", "version")
    .strict()
    .parserConfiguration({ "camel-case-expansion": true, "strip-dashed": true })
    .recommendCommands()
    .wrap(Math.min(120, cliTerminalWidth()))
    .middleware((argv) => {
      const command = String(argv._[0] ?? "");
      if (!command) return;
      const subcommand = String(argv._[1] ?? "");
      const args = argv as {
        format?: string;
        dryRun?: boolean;
        yes?: boolean;
      };
      const cmdLogger = baseLogger.child({
        command,
        subcommand,
        format: args.format,
        dryRun: args.dryRun,
        yes: args.yes,
      });
      (argv as { logger?: Logger }).logger = cmdLogger;
      cmdLogger.info({ event: "command_start" });
    })
    .fail((msg, err, y) => {
      if (!err && msg === "Specify a command") {
        y.showHelp("log");
        process.exit(0);
      }
      const error = err ?? new Error(msg);
      const exitCode = exitCodeForError(error);

      baseLogger.error({ event: "cli_fail", msg, err: error });

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
    .command(txCommand)
    .command(historyCommand)
    .command(reviewCommand)
    .command(fixCommand)
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
