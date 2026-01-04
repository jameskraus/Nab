import type { CommandModule } from "yargs";

export const historyCommand: CommandModule = {
  command: "history <command>",
  describe: "Inspect local ynac history (journal)",
  builder: (y) =>
    y
      .command({
        command: "show",
        describe: "Show recent actions recorded locally",
        handler: () => {
          throw new Error(
            "history is not implemented in the scaffold yet (see docs/BEADS.md)"
          );
        },
      })
      .command({
        command: "revert",
        describe: "Revert a recorded action (future feature)",
        builder: (yy) => yy.option("id", { type: "string", describe: "History id" }),
        handler: () => {
          throw new Error(
            "history revert is not implemented in the scaffold yet (see docs/BEADS.md)"
          );
        },
      })
      .demandCommand(1, "Specify a history subcommand")
      .strict(),
  handler: () => {},
};
