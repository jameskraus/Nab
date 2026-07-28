import type { NewTransaction, TransactionDetail } from "ynab";

import type { TransactionPatch, YnabApiClient } from "@/api/YnabClient";
import {
  type CategoryAssignmentResult,
  CategoryBudgetService,
} from "@/domain/CategoryBudgetService";
import { TransactionService } from "@/domain/TransactionService";
import type { TransactionMutationStatus } from "@/domain/TransactionService";
import type {
  DeletePatch,
  HistoryAction,
  HistoryForwardPatch,
  HistoryInversePatch,
  HistoryPatchEntry,
  HistoryPatchList,
  HistoryResource,
  MonthCategoryPatch,
  RestorePatch,
} from "@/journal/history";

export type RevertResult = {
  id: string;
  status: TransactionMutationStatus;
  patch?: HistoryInversePatch;
  restoredId?: string;
  resource?: HistoryResource;
  month?: string;
  categoryAssignment?: CategoryAssignmentResult;
};

export type RevertOutcome = {
  results: RevertResult[];
  appliedPatches: HistoryPatchList<HistoryForwardPatch>;
  inversePatches: HistoryPatchList<HistoryInversePatch>;
  restored: Array<{ originalId: string; newId: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePatchEntries<Patch>(value: unknown, label: string): HistoryPatchList<Patch> {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${label} patch list (expected array).`);
  }

  const entries: HistoryPatchList<Patch> = [];
  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error(`Invalid ${label} patch entry.`);
    }
    const id = item.id;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error(`Invalid ${label} patch entry id.`);
    }
    const resource = item.resource;
    if (resource !== undefined && resource !== "transaction" && resource !== "month_category") {
      throw new Error(`Invalid ${label} patch resource.`);
    }
    const month = item.month;
    if (month !== undefined && typeof month !== "string") {
      throw new Error(`Invalid ${label} patch month.`);
    }
    entries.push({
      id,
      patch: item.patch as Patch,
      ...(resource === undefined ? {} : { resource }),
      ...(month === undefined ? {} : { month }),
    });
  }
  return entries;
}

function isRestorePatch(patch: unknown): patch is RestorePatch {
  return isRecord(patch) && "restore" in patch;
}

function isDeletePatch(patch: unknown): patch is DeletePatch {
  return isRecord(patch) && patch.delete === true;
}

function isTransactionPatchLike(patch: unknown): patch is TransactionPatch {
  return isRecord(patch);
}

function isMonthCategoryPatch(patch: unknown): patch is MonthCategoryPatch {
  return (
    isRecord(patch) && typeof patch.budgeted === "number" && Number.isSafeInteger(patch.budgeted)
  );
}

function patchKey(entry: Pick<HistoryPatchEntry<unknown>, "id" | "resource" | "month">): string {
  return `${entry.resource ?? "transaction"}:${entry.month ?? ""}:${entry.id}`;
}

function assertRestorable(detail: TransactionDetail): void {
  if (detail.transfer_account_id || detail.transfer_transaction_id) {
    throw new Error("Transfers cannot be restored in v1.");
  }
  const hasSplits = Array.isArray(detail.subtransactions) && detail.subtransactions.length > 0;
  if (hasSplits) {
    throw new Error("Split transactions cannot be restored in v1.");
  }
}

function buildNewTransaction(detail: TransactionDetail): NewTransaction {
  if (!detail.account_id || !detail.date || typeof detail.amount !== "number") {
    throw new Error("Restore patch is missing required transaction fields.");
  }

  return {
    account_id: detail.account_id,
    date: detail.date,
    amount: detail.amount,
    payee_id: detail.payee_id ?? undefined,
    category_id: detail.category_id ?? undefined,
    memo: detail.memo ?? undefined,
    cleared: detail.cleared,
    approved: detail.approved,
    flag_color: detail.flag_color ?? undefined,
    import_id: detail.import_id ?? undefined,
  };
}

export async function revertHistoryAction(options: {
  ynab: YnabApiClient;
  budgetId: string;
  history: HistoryAction;
  dryRun?: boolean;
  allowOverAssigned?: boolean;
  allowNegativeAssigned?: boolean;
}): Promise<RevertOutcome> {
  const { ynab, budgetId, history, dryRun, allowOverAssigned, allowNegativeAssigned } = options;
  const inverseEntries = parsePatchEntries<HistoryInversePatch>(history.inversePatch, "inverse");
  if (inverseEntries.length === 0) {
    throw new Error("History action does not include an inverse patch.");
  }

  const forwardEntries = parsePatchEntries<HistoryForwardPatch>(
    history.payload?.patches,
    "payload",
  );
  const forwardMap = new Map<string, HistoryForwardPatch>();
  for (const entry of forwardEntries) {
    forwardMap.set(patchKey(entry), entry.patch);
  }

  const service = new TransactionService(ynab, budgetId);
  const categoryBudgetService = new CategoryBudgetService(ynab, budgetId);
  const results: RevertResult[] = [];
  const appliedPatches: HistoryPatchList<HistoryForwardPatch> = [];
  const inversePatches: HistoryPatchList<HistoryInversePatch> = [];
  const restored: Array<{ originalId: string; newId: string }> = [];

  for (const entry of inverseEntries) {
    const patch = entry.patch;

    if (entry.resource === "month_category") {
      if (!entry.month) {
        throw new Error("Month-category inverse patch is missing its month.");
      }
      if (!isMonthCategoryPatch(patch)) {
        throw new Error("Month-category inverse patch is invalid.");
      }
      const forwardPatch = forwardMap.get(patchKey(entry));
      if (!isMonthCategoryPatch(forwardPatch)) {
        throw new Error("Month-category history is missing a valid forward patch.");
      }
      const result = await categoryBudgetService.setAssigned(
        entry.id,
        entry.month,
        patch.budgeted,
        {
          dryRun,
          expectedCurrentMilliunits: forwardPatch.budgeted,
          allowOverAssigned,
          allowNegativeAssigned,
        },
      );
      results.push({
        id: entry.id,
        status: result.status,
        patch,
        resource: "month_category",
        month: result.month,
        categoryAssignment: result,
      });
      if (result.status === "updated") {
        appliedPatches.push({
          id: entry.id,
          resource: "month_category",
          month: result.month,
          patch,
        });
        inversePatches.push({
          id: entry.id,
          resource: "month_category",
          month: result.month,
          patch: forwardPatch,
        });
      }
      continue;
    }

    if (isRestorePatch(patch)) {
      const detail = patch.restore as TransactionDetail;
      if (!isRecord(detail)) {
        throw new Error("Restore patch is invalid.");
      }
      assertRestorable(detail);
      const createPayload = buildNewTransaction(detail);

      if (dryRun) {
        results.push({ id: entry.id, status: "dry-run", patch });
        continue;
      }

      const created = await ynab.createTransaction(budgetId, createPayload);
      results.push({ id: entry.id, status: "updated", patch, restoredId: created.id });
      appliedPatches.push({ id: created.id, patch: createPayload });
      inversePatches.push({ id: created.id, patch: { delete: true } });
      restored.push({ originalId: entry.id, newId: created.id });
      continue;
    }

    if (isDeletePatch(patch)) {
      const [result] = await service.deleteTransactions([entry.id], { dryRun });
      if (!result) continue;
      results.push(result);

      if (result.status === "updated") {
        if (result.patch) {
          appliedPatches.push({ id: result.id, patch: result.patch });
        }
        if (result.inversePatch) {
          inversePatches.push({ id: result.id, patch: result.inversePatch });
        }
      }
      continue;
    }

    if (!isTransactionPatchLike(patch)) {
      throw new Error("Inverse patch is invalid.");
    }

    const [result] = await service.applyPatch([entry.id], patch, { dryRun });
    if (!result) continue;
    results.push(result);

    if (result.status === "updated") {
      if (result.patch) {
        appliedPatches.push({ id: result.id, patch: result.patch });
      }
      const forwardPatch = forwardMap.get(
        patchKey({ id: result.id, resource: entry.resource, month: entry.month }),
      );
      if (forwardPatch !== undefined) {
        inversePatches.push({ id: result.id, patch: forwardPatch as HistoryInversePatch });
      }
    }
  }

  return {
    results,
    appliedPatches,
    inversePatches,
    restored,
  };
}
