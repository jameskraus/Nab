import type { CommandModule } from "yargs";

import type { AppContext } from "@/app/createAppContext";
import { requireApplyConfirmation } from "@/cli/mutations";
import type { CliGlobalArgs } from "@/cli/types";
import { type OutputWriterOptions, createOutputWriter, fieldColumn, parseOutputFormat } from "@/io";
import { normalizeArgv } from "@/journal/argv";
import {
  getHistoryAction,
  listHistoryActions,
  recordHistoryAction,
} from "@/journal/history";
import { revertHistoryAction, type RevertResult } from "@/journal/revert";

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
        describe: "Revert a recorded action",
        builder: (yy) =>
          yy.option("id", {
            type: "string",
            demandOption: true,
            describe: "History id to revert",
          }),
        handler: async (argv) => {
          const { appContext, format, dryRun, yes, id } = argv as unknown as CliGlobalArgs & {
            appContext?: AppContext;
            id: string;
          };

          const ctx = appContext;
          if (!ctx?.db) {
            throw new Error("History database is not available.");
          }
          if (!ctx.ynab || !ctx.budgetId) {
            throw new Error("Missing budget context for history revert.");
          }

          requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

          const action = getHistoryAction(ctx.db, id);
          if (!action) {
            throw new Error(`History action not found: ${id}`);
          }

          const outcome = await revertHistoryAction({
            ynab: ctx.ynab,
            budgetId: ctx.budgetId,
            history: action,
            dryRun: Boolean(dryRun),
          });

          const appliedIds = outcome.appliedPatches.map((entry) => entry.id);
          if (!dryRun && appliedIds.length > 0) {
            recordHistoryAction(
              ctx.db,
              "history.revert",
              {
                argv: normalizeArgv(argv as Record<string, unknown>),
                txIds: appliedIds,
                patches: outcome.appliedPatches,
                revertOf: action.id,
                sourceActionType: action.actionType,
                restored: outcome.restored,
              },
              outcome.inversePatches.length > 0 ? outcome.inversePatches : undefined,
            );
          }

          writeRevertResults(outcome.results, format);
        },
      })
      .demandCommand(1, "Specify a history subcommand")
      .strict(),
  handler: () => {},
};

type RevertRow = {
  id: string;
  status: string;
  patch: string;
  restoredId: string;
};

function writeRevertResults(results: RevertResult[], rawFormat?: string): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json").write(results);
    return;
  }

  if (format === "ids") {
    const ids = results.map((result) => result.restoredId ?? result.id);
    createOutputWriter("ids").write(ids);
    return;
  }

  const rows: RevertRow[] = results.map((result) => ({
    id: result.id,
    status: result.status,
    patch: result.patch ? JSON.stringify(result.patch) : "",
    restoredId: result.restoredId ?? "",
  }));

  if (format === "tsv") {
    createOutputWriter("tsv").write(rows);
    return;
  }

  createOutputWriter("table").write({
    columns: [
      fieldColumn("status", { header: "Status" }),
      fieldColumn("patch", { header: "Patch" }),
      fieldColumn("restoredId", { header: "Restored Id" }),
      fieldColumn("id", { header: "Id" }),
    ],
    rows,
  });
}
