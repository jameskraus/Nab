import type { TransactionDetail } from "ynab";

import type { TransactionPatch } from "@/api/YnabClient";
import type { YnabApiClient } from "@/api/YnabClient";
import { applyIdempotency, buildInversePatch } from "./transactionPatch";

export type TransactionMutationStatus = "updated" | "noop" | "dry-run";

export type MutationPatch = TransactionPatch | { delete: true };

export type MutationInversePatch = TransactionPatch | { restore: TransactionDetail };

export type TransactionMutationResult = {
  id: string;
  status: TransactionMutationStatus;
  patch?: MutationPatch;
  inversePatch?: MutationInversePatch;
};

export type TransactionMutationOptions = {
  dryRun?: boolean;
};

export class TransactionService {
  constructor(
    private readonly client: YnabApiClient,
    private readonly budgetId: string,
  ) {}

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
  ): Promise<TransactionMutationResult[]> {
    const results: TransactionMutationResult[] = [];
    const updates: Array<{ id: string; patch: TransactionPatch }> = [];

    for (const id of ids) {
      const transaction = await this.client.getTransaction(this.budgetId, id);
      const patch = buildPatch(transaction);
      const nextPatch = applyIdempotency(transaction, patch);

      if (!nextPatch) {
        results.push({ id, status: "noop" });
        continue;
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
      if (updates.length === 1) {
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

  private async updateTransaction(id: string, patch: TransactionPatch): Promise<TransactionDetail> {
    return this.client.updateTransaction(this.budgetId, id, patch);
  }
}
