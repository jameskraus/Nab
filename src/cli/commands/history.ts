import type { CommandModule } from "yargs";

import type { AppContext } from "@/app/createAppContext";
import { requireApplyConfirmation } from "@/cli/mutations";
import type { CliGlobalArgs } from "@/cli/types";
import { createOutputWriter, fieldColumn, parseOutputFormat } from "@/io";
import { normalizeArgv } from "@/journal/argv";
import {
  type HistoryAction,
  getHistoryAction,
  getHistoryActionByIndex,
  listHistoryActions,
  recordHistoryAction,
} from "@/journal/history";
import { type RevertResult, revertHistoryAction } from "@/journal/revert";

export const historyCommand: CommandModule<CliGlobalArgs> = {
  command: "history <command>",
  describe: "Inspect local nab history (journal)",
  builder: (y) =>
    y
      .command({
        command: "list",
        describe: "List recent actions recorded locally",
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
          writeHistoryList(actions, format);
        },
      })
      .command({
        command: "show <idOrIndex>",
        describe: "Show a recorded action by id or index",
        builder: (yy) =>
          yy.positional("idOrIndex", {
            type: "string",
            describe: "History id or zero-based index (0 is most recent)",
          }),
        handler: (argv) => {
          const { appContext, format, idOrIndex } = argv as unknown as CliGlobalArgs & {
            appContext?: AppContext;
            idOrIndex: string;
          };
          const ctx = appContext;
          if (!ctx?.db) {
            throw new Error("History database is not available.");
          }

          const selector = parseHistorySelector(idOrIndex);
          const action =
            selector.type === "index"
              ? getHistoryActionByIndex(ctx.db, selector.index)
              : getHistoryAction(ctx.db, selector.id);
          if (!action) {
            if (selector.type === "index") {
              throw new Error(`History index out of range: ${selector.index}`);
            }
            throw new Error(`History action not found: ${selector.id}`);
          }

          writeHistoryDetail(action, format);
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

type HistoryRow = {
  id: string;
  createdAt: string;
  actionType: string;
  txIds: string;
};

type RevertRow = {
  id: string;
  status: string;
  patch: string;
  restoredId: string;
};

type HistorySelector = { type: "id"; id: string } | { type: "index"; index: number };

function parseHistorySelector(value: string): HistorySelector {
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10);
    if (index < 0) {
      throw new Error("History index must be 0 or greater.");
    }
    return { type: "index", index };
  }
  return { type: "id", id: trimmed };
}

function historyRows(actions: HistoryAction[]): HistoryRow[] {
  return actions.map((action) => ({
    id: action.id,
    createdAt: action.createdAt,
    actionType: action.actionType,
    txIds: action.payload.txIds?.join(",") ?? "",
  }));
}

function writeHistoryList(actions: HistoryAction[], rawFormat?: string): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json").write(actions);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids").write(actions.map((action) => action.id));
    return;
  }

  const rows = historyRows(actions);

  if (format === "tsv") {
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
}

function writeHistoryDetail(action: HistoryAction, rawFormat?: string): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json").write(action);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids").write([action.id]);
    return;
  }

  const rows = historyRows([action]);

  if (format === "tsv") {
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
}

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
