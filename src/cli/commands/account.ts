import type { CommandModule } from "yargs";

function notImplemented() {
  throw new Error("Not implemented yet (see docs/BEADS.md)");
}

export const accountCommand: CommandModule = {
  command: "account <command>",
  describe: "Accounts",
  builder: (y) =>
    y
      .command({
        command: "list",
        describe: "List accounts for the effective budget",
        handler: notImplemented,
      })
      .demandCommand(1, "Specify an account subcommand")
      .strict(),
  handler: () => {},
};
