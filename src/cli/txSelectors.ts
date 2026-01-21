import type { Database } from "bun:sqlite";

import { normalizeIds } from "@/cli/mutations";
import { decodeCrockfordBase32, encodeCrockfordBase32 } from "@/refs/crockford";
import { resolveRef } from "@/refs/refLease";

export type TxSelectorArgs = {
  id?: string[] | string;
  ref?: string[] | string;
};

export type TxSelectorOptions = {
  requireSingle?: boolean;
};

const REF_ALLOWED_HINT =
  "Allowed: 0123456789ABCDEFGHJKMNPQRSTVWXYZ (case-insensitive), O->0, I/L->1.";

function invalidRefError(ref: string): Error {
  return new Error(`Invalid ref: ${ref}. ${REF_ALLOWED_HINT}`);
}

export function normalizeRefs(refs: string[] | string | undefined): string[] {
  if (!refs) return [];
  const values = Array.isArray(refs) ? refs : [refs];
  const normalized: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;

    try {
      const canonical = encodeCrockfordBase32(decodeCrockfordBase32(trimmed));
      normalized.push(canonical);
    } catch {
      throw invalidRefError(trimmed);
    }
  }

  return Array.from(new Set(normalized));
}

export function parseSelectors(args: TxSelectorArgs): { ids: string[]; refs: string[] } {
  return {
    ids: normalizeIds(args.id as string[] | string | undefined),
    refs: normalizeRefs(args.ref as string[] | string | undefined),
  };
}

export function validateSelectorInput(args: TxSelectorArgs, options: TxSelectorOptions = {}): void {
  const { ids, refs } = parseSelectors(args);

  if (ids.length > 0 && refs.length > 0) {
    throw new Error("Provide either --id or --ref, not both.");
  }
  if (ids.length === 0 && refs.length === 0) {
    throw new Error("Provide at least one --id or --ref value.");
  }
  if (options.requireSingle && ids.length + refs.length !== 1) {
    throw new Error("Provide exactly one --id or --ref value.");
  }
}

export function resolveSelectorIds(
  db: Database | undefined,
  args: TxSelectorArgs,
  options: TxSelectorOptions = {},
): string[] {
  validateSelectorInput(args, options);
  const { ids, refs } = parseSelectors(args);

  if (refs.length > 0) {
    if (!db) {
      throw new Error("Ref lookups require the local database.");
    }
    return refs.map((ref) => {
      const uuid = resolveRef(db, ref);
      if (!uuid) {
        throw new Error("Ref not found or expired. Re-run `nab tx list`.");
      }
      return uuid;
    });
  }

  return ids;
}
