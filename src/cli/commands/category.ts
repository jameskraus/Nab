import type { CommandModule } from "yargs";

function notImplemented() {
  throw new Error("Not implemented yet (see docs/BEADS.md)");
}

export const categoryCommand: CommandModule = {
  command: "category <command>",
  describe: "Categories",
  builder: (y) =>
    y
      .command({
        command: "list",
        describe: "List categories for the effective budget",
        handler: notImplemented,
      })
      .demandCommand(1, "Specify a category subcommand")
      .strict(),
  handler: () => {},
};
