import type { CommandModule } from "yargs";

import type { AppContext } from "@/app/createAppContext";
import type { CliGlobalArgs } from "@/cli/types";
import { type OutputWriterOptions, createOutputWriter, fieldColumn, parseOutputFormat } from "@/io";
import { listHistoryActions } from "@/journal/history";

export const historyCommand: CommandModule<CliGlobalArgs> = {
  command: "history <command>",
  describe: "Inspect local nab history (journal)",
  builder: (y) =>
    y
      .command({
        command: "show",
        describe: "Show recent actions recorded locally",
        builder: (yy) =>
          yy
            .option("limit", {
              type: "number",
              default: 20,
              describe: "Maximum number of history actions to show",
            })
            .option("since", {
              type: "string",
              describe: "Only include actions on/after this timestamp (ISO 8601)",
            }),
        handler: (argv) => {
          const { appContext, format, limit, since } = argv as unknown as CliGlobalArgs & {
            appContext?: AppContext;
            limit?: number;
            since?: string;
          };
          const ctx = appContext;
          if (!ctx?.db) {
            throw new Error("History database is not available.");
          }

          const actions = listHistoryActions(ctx.db, { limit, since });
          const formatChoice = parseOutputFormat(format, "table");

          if (formatChoice === "json") {
            createOutputWriter("json").write(actions);
            return;
          }

          if (formatChoice === "ids") {
            createOutputWriter("ids").write(actions.map((action) => action.id));
            return;
          }

          const rows = actions.map((action) => ({
            id: action.id,
            createdAt: action.createdAt,
            actionType: action.actionType,
            txIds: action.payload.txIds?.join(",") ?? "",
          }));

          if (formatChoice === "tsv") {
            createOutputWriter("tsv").write(rows);
            return;
          }

          createOutputWriter("table").write({
            columns: [
              fieldColumn("createdAt", { header: "Created" }),
              fieldColumn("actionType", { header: "Action" }),
              fieldColumn("txIds", { header: "Tx Ids" }),
              fieldColumn("id", { header: "Id" }),
            ],
            rows,
          });
        },
      })
      .command({
        command: "revert",
        describe: "Revert a recorded action (future feature)",
        builder: (yy) => yy.option("id", { type: "string", describe: "History id" }),
        handler: () => {
          throw new Error(
            "history revert is not implemented in the scaffold yet (see docs/BEADS.md)",
          );
        },
      })
      .demandCommand(1, "Specify a history subcommand")
      .strict(),
  handler: () => {},
};
