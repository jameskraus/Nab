import type { TransactionDetail } from "ynab";

import type { TransactionPatch } from "@/api/YnabClient";
import type { YnabApiClient } from "@/api/YnabClient";
import { resolveCategory } from "./nameResolution";
import { parseTransactionChanges } from "./transactionChanges";
import { applyIdempotency, buildInversePatch, isTransactionPatchNoop } from "./transactionPatch";

export type TransactionMutationStatus = "updated" | "noop" | "dry-run" | "unverified";

export type MutationPatch = TransactionPatch | { delete: true };

export type MutationInversePatch = TransactionPatch | { restore: TransactionDetail };

export type TransactionMutationResult = {
  id: string;
  status: TransactionMutationStatus;
  patch?: MutationPatch;
  inversePatch?: MutationInversePatch;
  transaction?: TransactionDetail;
  error?: string;
};

export class TransactionMutationError extends Error {
  constructor(public readonly results: TransactionMutationResult[]) {
    const ids = results
      .filter((result) => result.status === "unverified")
      .map((result) => result.id);
    super(`Could not verify changes for: ${ids.join(", ")}. Inspect results before retrying.`);
    this.name = "TransactionMutationError";
  }
}

export type TransactionMutationOptions = {
  dryRun?: boolean;
};

export class TransactionService {
  constructor(
    private readonly client: YnabApiClient,
    private readonly budgetId: string,
  ) {}

  async applyChanges(
    input: unknown,
    options: TransactionMutationOptions = {},
  ): Promise<TransactionMutationResult[]> {
    const { transactions } = parseTransactionChanges(input);
    const categories = transactions.some((change) => change.category_name !== undefined)
      ? await this.client.listCategories(this.budgetId)
      : [];
    const patches = new Map<string, TransactionPatch>();
    for (const { id, category_name, ...patch } of transactions) {
      patches.set(
        id,
        category_name === undefined
          ? patch
          : { ...patch, category_id: resolveCategory(category_name, categories) },
      );
    }

    return this.mutate(
      [...patches.keys()],
      (transaction) => {
        if (transaction.deleted) throw new Error(`Transaction ${transaction.id} is deleted.`);
        if (transaction.transfer_account_id || transaction.transfer_transaction_id) {
          throw new Error(`Transaction ${transaction.id} is a transfer; handle it separately.`);
        }
        if (transaction.subtransactions?.length) {
          throw new Error(`Transaction ${transaction.id} is split; split editing is unsupported.`);
        }
        return patches.get(transaction.id) as TransactionPatch;
      },
      options,
      true,
    );
  }

  async setApproved(
    ids: string[],
    approved: boolean,
    options: TransactionMutationOptions = {},
  ): Promise<TransactionMutationResult[]> {
    return this.applyPatch(ids, { approved }, options);
  }

  async applyPatch(
    ids: string[],
    patch: TransactionPatch,
    options: TransactionMutationOptions = {},
  ): Promise<TransactionMutationResult[]> {
    return this.mutate(ids, () => patch, options);
  }

  async mutateTransactions(
    ids: string[],
    buildPatch: (transaction: TransactionDetail) => TransactionPatch,
    options: TransactionMutationOptions = {},
  ): Promise<TransactionMutationResult[]> {
    return this.mutate(ids, buildPatch, options);
  }

  async deleteTransactions(
    ids: string[],
    options: TransactionMutationOptions = {},
  ): Promise<TransactionMutationResult[]> {
    const results: TransactionMutationResult[] = [];

    for (const id of ids) {
      const existing = await this.client.getTransaction(this.budgetId, id);
      if (options.dryRun) {
        results.push({
          id,
          status: "dry-run",
          patch: { delete: true },
          inversePatch: { restore: existing },
        });
        continue;
      }
      await this.client.deleteTransaction(this.budgetId, id);
      results.push({
        id,
        status: "updated",
        patch: { delete: true },
        inversePatch: { restore: existing },
      });
    }

    return results;
  }

  private async mutate(
    ids: string[],
    buildPatch: (transaction: TransactionDetail) => TransactionPatch,
    options: TransactionMutationOptions,
    verifyResults = false,
  ): Promise<TransactionMutationResult[]> {
    const results: TransactionMutationResult[] = [];
    const updates: Array<{ id: string; patch: TransactionPatch }> = [];

    for (const id of ids) {
      const transaction = await this.client.getTransaction(this.budgetId, id);
      if (verifyResults && transaction.id !== id) {
        throw new Error(`YNAB returned a different transaction for ${id}.`);
      }
      const patch = buildPatch(transaction);
      const nextPatch = applyIdempotency(transaction, patch);

      if (!nextPatch) {
        results.push({ id, status: "noop", ...(verifyResults ? { transaction } : {}) });
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(nextPatch, "category_id")) {
        if (transaction.transfer_account_id) {
          throw new Error("Transfers cannot be categorized.");
        }
      }

      if (nextPatch.account_id !== undefined) {
        if (transaction.transfer_account_id || transaction.transfer_transaction_id) {
          throw new Error("Transfers cannot be moved in v1.");
        }
      }

      if (options.dryRun) {
        results.push({
          id,
          status: "dry-run",
          patch: nextPatch,
          inversePatch: buildInversePatch(transaction, nextPatch),
          ...(verifyResults ? { transaction } : {}),
        });
        continue;
      }

      results.push({
        id,
        status: "updated",
        patch: nextPatch,
        inversePatch: buildInversePatch(transaction, nextPatch),
      });
      updates.push({ id, patch: nextPatch });
    }

    if (!options.dryRun && updates.length > 0) {
      if (verifyResults) {
        let saved: TransactionDetail[] = [];
        let writeError: unknown;
        try {
          saved = await this.client.updateTransactions(
            this.budgetId,
            updates.map((update) => ({ id: update.id, ...update.patch })),
          );
        } catch (error) {
          writeError = error;
        }
        await this.verifyChanges(results, saved, writeError);
      } else if (updates.length === 1) {
        const update = updates[0];
        if (update) {
          await this.updateTransaction(update.id, update.patch);
        }
      } else {
        await this.client.updateTransactions(
          this.budgetId,
          updates.map((update) => ({ id: update.id, ...update.patch })),
        );
      }
    }

    return results;
  }

  private async verifyChanges(
    results: TransactionMutationResult[],
    saved: TransactionDetail[],
    writeError: unknown,
  ): Promise<void> {
    const byId = new Map<string, TransactionDetail[]>();
    for (const transaction of saved) {
      const matches = byId.get(transaction.id) ?? [];
      matches.push(transaction);
      byId.set(transaction.id, matches);
    }
    for (const result of results) {
      if (result.status !== "updated") continue;
      const matches = byId.get(result.id);
      let transaction = matches?.length === 1 ? matches[0] : undefined;
      const matchesPatch = (value: TransactionDetail | undefined): boolean =>
        Boolean(
          value &&
            value.id === result.id &&
            !value.deleted &&
            Object.keys(result.patch ?? {}).every((key) => Object.hasOwn(value, key)) &&
            isTransactionPatchNoop(value, result.patch as TransactionPatch),
        );
      if (!matchesPatch(transaction)) {
        // Reconcile uncertain writes by reading only; never replay a changeset automatically.
        try {
          transaction = await this.client.getTransaction(this.budgetId, result.id);
        } catch (error) {
          transaction = undefined;
          result.error = `Readback failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      result.transaction = transaction;
      if (!matchesPatch(transaction)) {
        result.status = "unverified";
        result.error ??=
          writeError instanceof Error
            ? `Update failed: ${writeError.message}; requested fields could not be verified.`
            : "Saved transaction does not match the requested fields.";
      }
    }
    if (results.some((result) => result.status === "unverified")) {
      throw new TransactionMutationError(results);
    }
  }

  private async updateTransaction(id: string, patch: TransactionPatch): Promise<TransactionDetail> {
    return this.client.updateTransaction(this.budgetId, id, patch);
  }
}
