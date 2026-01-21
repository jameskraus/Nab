import type { Database } from "bun:sqlite";

import { decodeCrockfordBase32, encodeCrockfordBase32 } from "./crockford";

export const DEFAULT_REF_LEASE_MS = 30 * 24 * 60 * 60 * 1000;

type LeaseOptions = {
  nowMs?: number;
  leaseMs?: number;
};

function normalizeUuid(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("UUID must not be empty.");
  }
  return trimmed;
}

function resolveOptions(options?: LeaseOptions): { nowMs: number; leaseMs: number } {
  return {
    nowMs: options?.nowMs ?? Date.now(),
    leaseMs: options?.leaseMs ?? DEFAULT_REF_LEASE_MS,
  };
}

function cleanupExpired(db: Database, nowMs: number): void {
  db.query("delete from ref_lease where expires_at_ms <= ?").run(nowMs);
}

function withImmediateTransaction<T>(db: Database, fn: () => T): T {
  db.exec("begin immediate");
  try {
    const result = fn();
    db.exec("commit");
    return result;
  } catch (err) {
    db.exec("rollback");
    throw err;
  }
}

export function getOrCreateRef(db: Database, uuid: string, options?: LeaseOptions): string {
  const normalized = normalizeUuid(uuid);
  const { nowMs, leaseMs } = resolveOptions(options);
  const expiresAt = nowMs + leaseMs;

  return withImmediateTransaction(db, () => {
    cleanupExpired(db, nowMs);

    const existing = db
      .query<{ n: number }, [number, number, string]>(
        "update ref_lease set last_used_at_ms = ?, expires_at_ms = ? where uuid = ? returning n",
      )
      .get(nowMs, expiresAt, normalized);

    if (existing?.n !== undefined && existing?.n !== null) {
      return encodeCrockfordBase32(existing.n);
    }

    const inserted = db
      .query<{ n: number }, [string, number, number, number]>(
        "insert into ref_lease (uuid, assigned_at_ms, last_used_at_ms, expires_at_ms) values (?, ?, ?, ?) returning n",
      )
      .get(normalized, nowMs, nowMs, expiresAt);

    if (inserted?.n === undefined || inserted?.n === null) {
      throw new Error("Failed to allocate ref.");
    }

    return encodeCrockfordBase32(inserted.n);
  });
}

export function resolveRef(db: Database, ref: string, options?: LeaseOptions): string | null {
  const n = decodeCrockfordBase32(ref);
  const { nowMs, leaseMs } = resolveOptions(options);
  const expiresAt = nowMs + leaseMs;

  return withImmediateTransaction(db, () => {
    cleanupExpired(db, nowMs);

    const row = db
      .query<{ uuid: string }, [number, number, number]>(
        "update ref_lease set last_used_at_ms = ?, expires_at_ms = ? where n = ? returning uuid",
      )
      .get(nowMs, expiresAt, n);

    return row?.uuid ?? null;
  });
}

export function getOrCreateRefs(
  db: Database,
  uuids: string[],
  options?: LeaseOptions,
): Map<string, string> {
  const normalized = uuids.map((uuid) => normalizeUuid(uuid));
  const unique = Array.from(new Set(normalized));
  const { nowMs, leaseMs } = resolveOptions(options);
  const expiresAt = nowMs + leaseMs;

  if (unique.length === 0) return new Map();

  return withImmediateTransaction(db, () => {
    cleanupExpired(db, nowMs);

    const placeholders = unique.map(() => "?").join(", ");
    const existingRows = db
      .query<{ uuid: string; n: number }, string[]>(
        `select uuid, n from ref_lease where uuid in (${placeholders})`,
      )
      .all(...unique);

    const map = new Map<string, number>();
    for (const row of existingRows) {
      map.set(row.uuid, row.n);
    }

    const missing = unique.filter((uuid) => !map.has(uuid));
    if (missing.length > 0) {
      const insertValues = missing.map(() => "(?, ?, ?, ?)").join(", ");
      const insertParams: Array<string | number> = [];
      for (const uuid of missing) {
        insertParams.push(uuid, nowMs, nowMs, expiresAt);
      }

      const insertedRows = db
        .query<{ uuid: string; n: number }, Array<string | number>>(
          `insert into ref_lease (uuid, assigned_at_ms, last_used_at_ms, expires_at_ms) values ${insertValues} returning uuid, n`,
        )
        .all(...insertParams);

      for (const row of insertedRows) {
        map.set(row.uuid, row.n);
      }
    }

    db.query<unknown, Array<number | string>>(
      `update ref_lease set last_used_at_ms = ?, expires_at_ms = ? where uuid in (${placeholders})`,
    ).run(nowMs, expiresAt, ...unique);

    const output = new Map<string, string>();
    for (const uuid of unique) {
      const n = map.get(uuid);
      if (n === undefined) {
        throw new Error(`Failed to resolve ref for UUID: ${uuid}`);
      }
      output.set(uuid, encodeCrockfordBase32(n));
    }

    return output;
  });
}
