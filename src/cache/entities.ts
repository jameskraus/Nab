import type { Database } from "bun:sqlite";

export type CachedEntity = {
  id: string;
  data: unknown;
};

export function upsertCachedEntities(
  db: Database,
  budgetId: string,
  entityType: string,
  entities: CachedEntity[],
): void {
  if (entities.length === 0) return;

  const stmt = db.prepare(
    `insert into cache_entities (budget_id, entity_type, entity_id, data_json, updated_at)
     values (?, ?, ?, ?, datetime('now'))
     on conflict(budget_id, entity_type, entity_id)
     do update set data_json = excluded.data_json, updated_at = datetime('now')`,
  );

  db.exec("begin");
  try {
    for (const entity of entities) {
      stmt.run(budgetId, entityType, entity.id, JSON.stringify(entity.data));
    }
    db.exec("commit");
  } catch (err) {
    db.exec("rollback");
    throw err;
  }
}

export function listCachedEntities(
  db: Database,
  budgetId: string,
  entityType: string,
): CachedEntity[] {
  const rows = db
    .query<{ entityId: string; dataJson: string }, [string, string]>(
      `select entity_id as entityId, data_json as dataJson
       from cache_entities
       where budget_id = ? and entity_type = ?
       order by entity_id`,
    )
    .all(budgetId, entityType);

  return rows.map((row) => ({
    id: row.entityId,
    data: JSON.parse(row.dataJson),
  }));
}
