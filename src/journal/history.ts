import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export type HistoryActionPayload = {
  argv: Record<string, unknown>;
  txIds: string[];
  patches?: Array<{ id: string; patch: unknown }>;
  revertOf?: string;
  restored?: Array<{ originalId: string; newId: string }>;
  sourceActionType?: string;
};

export type HistoryAction = {
  id: string;
  createdAt: string;
  actionType: string;
  payload: HistoryActionPayload;
  inversePatch?: unknown;
};

export type HistoryQuery = {
  limit?: number;
  since?: string;
};

export function recordHistoryAction(
  db: Database,
  actionType: string,
  payload: HistoryActionPayload,
  inversePatch?: unknown,
): HistoryAction {
  const id = randomUUID();
  const payloadJson = JSON.stringify(payload);
  const inverseJson = inversePatch ? JSON.stringify(inversePatch) : null;

  db.query(
    `insert into history_actions (id, action_type, payload_json, inverse_patch_json)
     values (?, ?, ?, ?)`,
  ).run(id, actionType, payloadJson, inverseJson);

  const row = db
    .query<HistoryAction, [string]>(
      `select id, created_at as createdAt, action_type as actionType,
              payload_json as payloadJson, inverse_patch_json as inverseJson
       from history_actions
       where id = ?`,
    )
    .get(id);

  if (!row) {
    throw new Error("Failed to load history action after insert.");
  }

  return {
    id: row.id,
    createdAt: row.createdAt,
    actionType: row.actionType,
    payload: JSON.parse(
      (row as unknown as { payloadJson: string }).payloadJson,
    ) as HistoryActionPayload,
    inversePatch: (row as unknown as { inverseJson?: string | null }).inverseJson
      ? JSON.parse((row as unknown as { inverseJson: string }).inverseJson)
      : undefined,
  };
}

export function getHistoryAction(db: Database, id: string): HistoryAction | null {
  const row = db
    .query<
      {
        id: string;
        createdAt: string;
        actionType: string;
        payloadJson: string;
        inverseJson: string | null;
      },
      [string]
    >(
      `select id, created_at as createdAt, action_type as actionType,
              payload_json as payloadJson, inverse_patch_json as inverseJson
       from history_actions
       where id = ?`,
    )
    .get(id);

  if (!row) return null;

  return {
    id: row.id,
    createdAt: row.createdAt,
    actionType: row.actionType,
    payload: JSON.parse(row.payloadJson) as HistoryActionPayload,
    inversePatch: row.inverseJson ? JSON.parse(row.inverseJson) : undefined,
  };
}

export function getHistoryActionByIndex(db: Database, index: number): HistoryAction | null {
  const row = db
    .query<
      {
        id: string;
        createdAt: string;
        actionType: string;
        payloadJson: string;
        inverseJson: string | null;
      },
      [number]
    >(
      `select id, created_at as createdAt, action_type as actionType,
              payload_json as payloadJson, inverse_patch_json as inverseJson
       from history_actions
       order by created_at desc
       limit 1 offset ?`,
    )
    .get(index);

  if (!row) return null;

  return {
    id: row.id,
    createdAt: row.createdAt,
    actionType: row.actionType,
    payload: JSON.parse(row.payloadJson) as HistoryActionPayload,
    inversePatch: row.inverseJson ? JSON.parse(row.inverseJson) : undefined,
  };
}

export function listHistoryActions(db: Database, query: HistoryQuery = {}): HistoryAction[] {
  const limit = query.limit ?? 20;
  const since = query.since;

  const rows = db
    .query<
      {
        id: string;
        createdAt: string;
        actionType: string;
        payloadJson: string;
        inverseJson: string | null;
      },
      [string | null, string | null, number]
    >(
      `select id,
              created_at as createdAt,
              action_type as actionType,
              payload_json as payloadJson,
              inverse_patch_json as inverseJson
       from history_actions
       where (?1 is null or created_at >= ?2)
       order by created_at desc
       limit ?3`,
    )
    .all(since ?? null, since ?? null, limit);

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    actionType: row.actionType,
    payload: JSON.parse(row.payloadJson) as HistoryActionPayload,
    inversePatch: row.inverseJson ? JSON.parse(row.inverseJson) : undefined,
  }));
}
