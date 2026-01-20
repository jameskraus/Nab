import type { Argv } from "yargs";

import { defineCommand } from "@/cli/command";
import { requireApplyConfirmation } from "@/cli/mutations";
import { getOutputWriterOptions } from "@/cli/outputOptions";
import { type OutputWriterOptions, createOutputWriter, fieldColumn, parseOutputFormat } from "@/io";
import { normalizeArgv } from "@/journal/argv";
import {
  type HistoryAction,
  getHistoryAction,
  getHistoryActionByIndex,
  listHistoryActions,
  recordHistoryAction,
} from "@/journal/history";
import { type RevertResult, revertHistoryAction } from "@/journal/revert";

export const historyCommand = {
  command: "history <command>",
  describe: "Inspect local nab history (journal)",
  builder: (y: Argv<Record<string, unknown>>) =>
    y
      .command(
        defineCommand({
          command: "list",
          describe: "List recent actions recorded locally",
          requirements: { db: true },
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
          handler: (argv, ctx) => {
            const args = argv as { limit?: number; since?: string; format?: string };
            const actions = listHistoryActions(ctx.db, { limit: args.limit, since: args.since });
            writeHistoryList(actions, args.format, getOutputWriterOptions(argv));
          },
        }),
      )
      .command(
        defineCommand({
          command: "show <idOrIndex>",
          describe: "Show a recorded action by id or index",
          requirements: { db: true },
          builder: (yy) =>
            yy.positional("idOrIndex", {
              type: "string",
              describe: "History id or zero-based index (0 is most recent)",
            }),
          handler: (argv, ctx) => {
            const args = argv as unknown as { idOrIndex: string; format?: string };
            const selector = parseHistorySelector(args.idOrIndex);
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

            writeHistoryDetail(action, args.format, getOutputWriterOptions(argv));
          },
        }),
      )
      .command(
        defineCommand({
          command: "revert",
          describe: "Revert a recorded action",
          requirements: { db: true, auth: true, budget: "required", mutation: true },
          builder: (yy) =>
            yy.option("id", {
              type: "string",
              demandOption: true,
              describe: "History id to revert",
            }),
          handler: async (argv, ctx) => {
            const args = argv as unknown as {
              id: string;
              format?: string;
              dryRun?: boolean;
              yes?: boolean;
            };
            const dryRun = Boolean(args.dryRun);
            requireApplyConfirmation(dryRun, Boolean(args.yes));

            const action = getHistoryAction(ctx.db, args.id);
            if (!action) {
              throw new Error(`History action not found: ${args.id}`);
            }

            const outcome = await revertHistoryAction({
              ynab: ctx.ynab,
              budgetId: ctx.budgetId,
              history: action,
              dryRun,
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

            writeRevertResults(outcome.results, args.format, getOutputWriterOptions(argv));
          },
        }),
      )
      .demandCommand(1, "Specify a history subcommand")
      .strict(),
  handler: () => {},
} as const;

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

function writeHistoryList(
  actions: HistoryAction[],
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json", options).write(actions);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write(actions.map((action) => action.id));
    return;
  }

  const rows = historyRows(actions);

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [
      fieldColumn("createdAt", { header: "Created" }),
      fieldColumn("actionType", { header: "Action" }),
      fieldColumn("txIds", { header: "Tx Ids" }),
      fieldColumn("id", { header: "Id" }),
    ],
    rows,
  });
}

function writeHistoryDetail(
  action: HistoryAction,
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json", options).write(action);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write([action.id]);
    return;
  }

  const rows = historyRows([action]);

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [
      fieldColumn("createdAt", { header: "Created" }),
      fieldColumn("actionType", { header: "Action" }),
      fieldColumn("txIds", { header: "Tx Ids" }),
      fieldColumn("id", { header: "Id" }),
    ],
    rows,
  });
}

function writeRevertResults(
  results: RevertResult[],
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json", options).write(results);
    return;
  }

  if (format === "ids") {
    const ids = results.map((result) => result.restoredId ?? result.id);
    createOutputWriter("ids", options).write(ids);
    return;
  }

  const rows: RevertRow[] = results.map((result) => ({
    id: result.id,
    status: result.status,
    patch: result.patch ? JSON.stringify(result.patch) : "",
    restoredId: result.restoredId ?? "",
  }));

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [
      fieldColumn("status", { header: "Status" }),
      fieldColumn("patch", { header: "Patch" }),
      fieldColumn("restoredId", { header: "Restored Id" }),
      fieldColumn("id", { header: "Id" }),
    ],
    rows,
  });
}
