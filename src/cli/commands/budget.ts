import type { CommandModule } from "yargs";

function notImplemented() {
  throw new Error("Not implemented yet (see docs/BEADS.md)");
}

export const budgetCommand: CommandModule = {
  command: "budget <command>",
  describe: "Budgets",
  builder: (y) =>
    y
      .command({
        command: "list",
        describe: "List budgets available to the token",
        handler: notImplemented,
      })
      .command({
        command: "current",
        describe: "Show the effective budget (from --budget-id or config)",
        handler: notImplemented,
      })
      .demandCommand(1, "Specify a budget subcommand")
      .strict(),
  handler: () => {},
};
