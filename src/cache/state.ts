import type { Database } from "bun:sqlite";

export type CacheState = {
  budgetId: string;
  resource: string;
  serverKnowledge: number;
};

export function getCacheState(
  db: Database,
  budgetId: string,
  resource: string,
): CacheState | undefined {
  const row = db
    .query<{ budgetId: string; resource: string; serverKnowledge: number }, [string, string]>(
      `select budget_id as budgetId, resource, server_knowledge as serverKnowledge
       from cache_state
       where budget_id = ? and resource = ?`,
    )
    .get(budgetId, resource);
  return row ?? undefined;
}

export function setCacheState(
  db: Database,
  budgetId: string,
  resource: string,
  serverKnowledge: number,
): void {
  db.query(
    `insert into cache_state (budget_id, resource, server_knowledge, updated_at)
     values (?, ?, ?, datetime('now'))
     on conflict(budget_id, resource)
     do update set server_knowledge = excluded.server_knowledge, updated_at = datetime('now')`,
  ).run(budgetId, resource, serverKnowledge);
}

export function listCacheStates(db: Database, budgetId: string): CacheState[] {
  return db
    .query<{ budgetId: string; resource: string; serverKnowledge: number }, [string]>(
      `select budget_id as budgetId, resource, server_knowledge as serverKnowledge
       from cache_state
       where budget_id = ?
       order by resource`,
    )
    .all(budgetId);
}
