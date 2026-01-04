import type { CommandModule } from "yargs";

function notImplemented() {
  throw new Error("Not implemented yet (see docs/BEADS.md)");
}

export const payeeCommand: CommandModule = {
  command: "payee <command>",
  describe: "Payees",
  builder: (y) =>
    y
      .command({
        command: "list",
        describe: "List payees for the effective budget",
        handler: notImplemented,
      })
      .demandCommand(1, "Specify a payee subcommand")
      .strict(),
  handler: () => {},
};
