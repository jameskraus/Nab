import type { Argv } from "yargs";

import {
  reviewMislinkedTransfersCommand,
  writeMislinkedTransfers,
} from "./reviewMislinkedTransfers";
import { reviewTransactionsCommand } from "./reviewTransactions";

export { writeMislinkedTransfers };

export const reviewCommand = {
  command: "review <command>",
  describe: "Review checks",
  builder: (y: Argv<Record<string, unknown>>) =>
    y
      .command(reviewMislinkedTransfersCommand)
      .command(reviewTransactionsCommand)
      .demandCommand(1, "Specify a review subcommand")
      .strict(),
  handler: () => {},
} as const;
