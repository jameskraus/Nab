import type { Database } from "bun:sqlite";
import type { Argv } from "yargs";
import type { Account, TransactionDetail } from "ynab";

import type { YnabApiClient } from "@/api/YnabClient";
import { NotFoundError } from "@/api/errors";
import { defineCommand } from "@/cli/command";
import { requireApplyConfirmation } from "@/cli/mutations";
import { getOutputWriterOptions } from "@/cli/outputOptions";
import { withinDayDelta } from "@/domain/dateOnly";
import {
  accountKind,
  isAnchorTransaction,
  isOrphanCandidate,
  isPhantomTransaction,
} from "@/domain/mislinkedTransferPredicates";
import { buildInversePatch } from "@/domain/transactionPatch";
import { isDirectImportActive } from "@/domain/ynab/accountPredicates";
import { type OutputWriterOptions, createOutputWriter, fieldColumn, parseOutputFormat } from "@/io";
import { normalizeArgv } from "@/journal/argv";
import {
  type HistoryForwardPatch,
  type HistoryInversePatch,
  type HistoryPatchList,
  recordHistoryAction,
} from "@/journal/history";
import { resolveRef } from "@/refs/refLease";

const DEFAULT_IMPORT_LAG_DAYS = 5;
const RELINK_POLL_ATTEMPTS = 3;
const RELINK_POLL_DELAY_MS = 250;

type FixArgs = {
  anchor: string;
  phantom: string;
  orphan: string;
  importLagDays?: number;
  dryRun?: boolean;
  yes?: boolean;
  format?: string;
  quiet?: boolean;
  noColor?: boolean;
};

type FixResult = {
  action: string;
  id: string;
  status: string;
  patch?: string;
};

type FixYnabClient = Pick<
  YnabApiClient,
  "getTransaction" | "listAccounts" | "updateTransaction" | "deleteTransaction"
>;

export type FixMislinkedTransferContext = {
  ynab: FixYnabClient;
  budgetId: string;
  db?: Database;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadRelinkPollConfig(): { attempts: number; delayMs: number } {
  const attemptsRaw = process.env.NAB_RELINK_POLL_ATTEMPTS;
  const delayRaw = process.env.NAB_RELINK_POLL_DELAY_MS;
  const attempts = attemptsRaw ? Number.parseInt(attemptsRaw, 10) : RELINK_POLL_ATTEMPTS;
  const delayMs = delayRaw ? Number.parseInt(delayRaw, 10) : RELINK_POLL_DELAY_MS;

  return {
    attempts: Number.isFinite(attempts) && attempts >= 0 ? attempts : RELINK_POLL_ATTEMPTS,
    delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : RELINK_POLL_DELAY_MS,
  };
}

function resolveIdOrRef(db: Parameters<typeof resolveRef>[0] | undefined, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Transaction selector cannot be empty.");
  }
  if (trimmed.includes("-")) {
    return trimmed;
  }
  if (!db) {
    throw new Error("Ref lookups require the local database.");
  }
  const resolved = resolveRef(db, trimmed);
  if (!resolved) {
    throw new Error(`Ref not found or expired: ${trimmed}. Re-run a list command to refresh refs.`);
  }
  return resolved;
}

function writeFixResults(
  results: FixResult[],
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json", options).write(results);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write(results.map((result) => result.id));
    return;
  }

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(results);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [
      fieldColumn("action", { header: "Action" }),
      fieldColumn("status", { header: "Status" }),
      fieldColumn("patch", { header: "Patch" }),
      fieldColumn("id", { header: "Id" }),
    ],
    rows: results,
  });
}

function requireAccount(
  accountById: Map<string, Account>,
  accountId: string,
  label: string,
): Account {
  const account = accountById.get(accountId);
  if (!account) {
    throw new Error(`Missing ${label} account: ${accountId}`);
  }
  if (account.deleted) {
    throw new Error(`${label[0]?.toUpperCase()}${label.slice(1)} account is deleted.`);
  }
  return account;
}

function requireTransactionNotDeleted(
  transaction: TransactionDetail,
  label: string,
): void {
  if (transaction.deleted) {
    throw new Error(`${label[0]?.toUpperCase()}${label.slice(1)} transaction is deleted.`);
  }
}

function requireLinkedTransfer(anchor: TransactionDetail, phantom: TransactionDetail): void {
  const anchorLink = anchor.transfer_transaction_id;
  const phantomLink = phantom.transfer_transaction_id;
  if (!anchorLink || !phantomLink) {
    throw new Error("Anchor and phantom must be linked transfer transactions.");
  }
  if (anchorLink !== phantom.id || phantomLink !== anchor.id) {
    throw new Error("Anchor and phantom are not linked to each other.");
  }
  if (!anchor.transfer_account_id || !phantom.transfer_account_id) {
    throw new Error("Anchor and phantom must include transfer account ids.");
  }
  if (anchor.transfer_account_id !== phantom.account_id) {
    throw new Error("Anchor transfer account does not match phantom account.");
  }
  if (phantom.transfer_account_id !== anchor.account_id) {
    throw new Error("Phantom transfer account does not match anchor account.");
  }
}

function requireAnchorPhantomStatus(anchor: TransactionDetail, phantom: TransactionDetail): void {
  if (!isAnchorTransaction(anchor)) {
    throw new Error("Anchor must be imported and cleared.");
  }
  if (!isPhantomTransaction(phantom)) {
    throw new Error("Phantom must have no import_id and be uncleared.");
  }
}

function requireOrphanCandidate(orphan: TransactionDetail): void {
  if (orphan.transfer_account_id || orphan.transfer_transaction_id) {
    throw new Error("Orphan candidate must not be a transfer.");
  }
  if (!isOrphanCandidate(orphan)) {
    throw new Error("Orphan candidate must be imported and cleared.");
  }
}

async function pollPhantomUnlinked(
  ynab: FixYnabClient,
  budgetId: string,
  phantomId: string,
  anchorId: string,
): Promise<TransactionDetail | null> {
  const { attempts, delayMs } = loadRelinkPollConfig();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const phantom = await ynab.getTransaction(budgetId, phantomId);
      if (phantom.transfer_transaction_id !== anchorId) {
        return phantom;
      }
    } catch (err) {
      if (err instanceof NotFoundError) {
        return null;
      }
      throw err;
    }

    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }

  try {
    return await ynab.getTransaction(budgetId, phantomId);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return null;
    }
    throw err;
  }
}

export async function runFixMislinkedTransfer(
  argv: FixArgs & Record<string, unknown>,
  ctx: FixMislinkedTransferContext,
): Promise<void> {
  const args = argv as FixArgs;
  const dryRun = Boolean(args.dryRun);
  requireApplyConfirmation(dryRun, Boolean(args.yes));

  const importLagDays = args.importLagDays ?? DEFAULT_IMPORT_LAG_DAYS;
  if (!Number.isFinite(importLagDays) || importLagDays < 0) {
    throw new Error("--import-lag-days must be 0 or greater.");
  }

  const anchorId = resolveIdOrRef(ctx.db, args.anchor);
  const phantomId = resolveIdOrRef(ctx.db, args.phantom);
  const orphanId = resolveIdOrRef(ctx.db, args.orphan);

  const [anchor, phantom, orphan, accounts] = await Promise.all([
    ctx.ynab.getTransaction(ctx.budgetId, anchorId),
    ctx.ynab.getTransaction(ctx.budgetId, phantomId),
    ctx.ynab.getTransaction(ctx.budgetId, orphanId),
    ctx.ynab.listAccounts(ctx.budgetId),
  ]);

  requireTransactionNotDeleted(anchor, "anchor");
  requireTransactionNotDeleted(phantom, "phantom");
  requireTransactionNotDeleted(orphan, "orphan");

  requireLinkedTransfer(anchor, phantom);
  requireAnchorPhantomStatus(anchor, phantom);
  requireOrphanCandidate(orphan);

  if (orphan.amount !== phantom.amount) {
    throw new Error("Orphan amount must exactly match phantom amount.");
  }

  if (!withinDayDelta(orphan.date, phantom.date, importLagDays)) {
    throw new Error("Orphan date is outside the import lag window.");
  }

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const anchorAccount = requireAccount(accountById, anchor.account_id, "anchor");
  const phantomAccount = requireAccount(accountById, phantom.account_id, "phantom");
  const orphanAccount = requireAccount(accountById, orphan.account_id, "orphan");

  if (!isDirectImportActive(anchorAccount)) {
    throw new Error("Anchor account is not direct-import linked or is in error.");
  }
  if (!isDirectImportActive(phantomAccount)) {
    throw new Error("Phantom account is not direct-import linked or is in error.");
  }
  if (!isDirectImportActive(orphanAccount)) {
    throw new Error("Orphan account is not direct-import linked or is in error.");
  }

  const phantomKind = accountKind(phantomAccount);
  const orphanKind = accountKind(orphanAccount);
  if (!phantomKind || !orphanKind || phantomKind !== orphanKind) {
    throw new Error("Orphan account type must match phantom account type.");
  }

  const anchorTransferPayeeId = anchorAccount.transfer_payee_id;
  if (!anchorTransferPayeeId) {
    throw new Error("Anchor account does not provide a transfer payee id.");
  }

  // Fix flow: re-link by turning the imported orphan into a transfer to the anchor account.
  // YNAB will create the other side of the transfer; then we can safely delete the phantom.
  const patch = { payee_id: anchorTransferPayeeId };

  const results: FixResult[] = [];
  const historyPatches: HistoryPatchList<HistoryForwardPatch> = [];
  const inversePatches: HistoryPatchList<HistoryInversePatch> = [];

  if (dryRun) {
    results.push({
      action: "update-orphan-payee",
      id: orphan.id,
      status: "dry-run",
      patch: JSON.stringify(patch),
    });
    results.push({
      action: "delete-phantom",
      id: phantom.id,
      status: "dry-run",
      patch: JSON.stringify({ delete: true }),
    });
    writeFixResults(results, args.format, getOutputWriterOptions(args));
    return;
  }

  let orphanUpdated = false;
  let phantomDeleted = false;
  let deleteError: unknown = null;

  await ctx.ynab.updateTransaction(ctx.budgetId, orphan.id, patch);
  orphanUpdated = true;
  results.push({
    action: "update-orphan-payee",
    id: orphan.id,
    status: "updated",
    patch: JSON.stringify(patch),
  });
  historyPatches.push({ id: orphan.id, patch });
  inversePatches.push({ id: orphan.id, patch: buildInversePatch(orphan, patch) });

  const phantomAfterUpdate = await pollPhantomUnlinked(
    ctx.ynab,
    ctx.budgetId,
    phantom.id,
    anchor.id,
  );
  if (phantomAfterUpdate && phantomAfterUpdate.transfer_transaction_id === anchor.id) {
    results.push({
      action: "delete-phantom",
      id: phantom.id,
      status: "blocked",
      patch: JSON.stringify({ delete: true }),
    });

    if (ctx.db && historyPatches.length > 0) {
      recordHistoryAction(
        ctx.db,
        "fix.mislinked-transfer",
        {
          argv: normalizeArgv(argv as Record<string, unknown>),
          txIds: historyPatches.map((entry) => entry.id),
          patches: historyPatches,
        },
        inversePatches.length > 0 ? inversePatches : undefined,
      );
    }

    writeFixResults(results, args.format, getOutputWriterOptions(args));
    throw new Error(
      "Phantom is still linked to anchor after relink attempt. Aborting to avoid deleting anchor.",
    );
  }

  if (!phantomAfterUpdate) {
    results.push({
      action: "delete-phantom",
      id: phantom.id,
      status: "skipped",
      patch: JSON.stringify({ delete: true }),
    });

    if (ctx.db && historyPatches.length > 0) {
      recordHistoryAction(
        ctx.db,
        "fix.mislinked-transfer",
        {
          argv: normalizeArgv(argv as Record<string, unknown>),
          txIds: historyPatches.map((entry) => entry.id),
          patches: historyPatches,
        },
        inversePatches.length > 0 ? inversePatches : undefined,
      );
    }

    writeFixResults(results, args.format, getOutputWriterOptions(args));
    return;
  }

  try {
    await ctx.ynab.deleteTransaction(ctx.budgetId, phantom.id);
    phantomDeleted = true;
    results.push({
      action: "delete-phantom",
      id: phantom.id,
      status: "updated",
      patch: JSON.stringify({ delete: true }),
    });
    historyPatches.push({ id: phantom.id, patch: { delete: true } });
  } catch (err) {
    deleteError = err;
    results.push({
      action: "delete-phantom",
      id: phantom.id,
      status: "failed",
      patch: JSON.stringify({ delete: true }),
    });
  }

  if (ctx.db && historyPatches.length > 0) {
    recordHistoryAction(
      ctx.db,
      "fix.mislinked-transfer",
      {
        argv: normalizeArgv(argv as Record<string, unknown>),
        txIds: historyPatches.map((entry) => entry.id),
        patches: historyPatches,
      },
      inversePatches.length > 0 ? inversePatches : undefined,
    );
  }

  writeFixResults(results, args.format, getOutputWriterOptions(args));

  if (orphanUpdated && !phantomDeleted && deleteError) {
    throw new Error("Orphan was updated but phantom deletion failed. Manual cleanup required.");
  }
}

export const fixCommand = {
  command: "fix <command>",
  describe: "Fix known issues",
  builder: (y: Argv<Record<string, unknown>>) =>
    y
      .command(
        defineCommand({
          command: "mislinked-transfer",
          describe: "Fix a mislinked transfer by linking the orphan to the anchor account",
          requirements: { auth: true, budget: "required", db: true, mutation: true },
          builder: (yy) =>
            yy
              .option("anchor", {
                type: "string",
                demandOption: true,
                describe: "Anchor transaction id or ref",
              })
              .option("phantom", {
                type: "string",
                demandOption: true,
                describe: "Phantom transaction id or ref",
              })
              .option("orphan", {
                type: "string",
                demandOption: true,
                describe: "Orphan transaction id or ref",
              })
              .option("import-lag-days", {
                type: "number",
                default: DEFAULT_IMPORT_LAG_DAYS,
                describe: "Maximum +/- day delta between phantom and orphan candidates",
              }),
          handler: async (argv, ctx) => {
            await runFixMislinkedTransfer(
              argv as unknown as FixArgs & Record<string, unknown>,
              ctx,
            );
          },
        }),
      )
      .demandCommand(1, "Specify a fix subcommand")
      .strict(),
  handler: () => {},
} as const;
