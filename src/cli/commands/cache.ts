import type { CommandModule } from "yargs";

function notImplemented() {
  throw new Error("Not implemented yet (see docs/BEADS.md)");
}

export const cacheCommand: CommandModule = {
  command: "cache <command>",
  describe: "Local cache management",
  builder: (y) =>
    y
      .command({
        command: "sync",
        describe: "Sync local sqlite cache using YNAB delta requests",
        handler: notImplemented,
      })
      .command({
        command: "status",
        describe: "Show cache state (server_knowledge per resource)",
        handler: notImplemented,
      })
      .demandCommand(1, "Specify a cache subcommand")
      .strict(),
  handler: () => {},
};
