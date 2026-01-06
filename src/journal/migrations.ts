import type { Database } from "bun:sqlite";

type Migration = {
  id: string;
  sql: string;
};

const migrations: Migration[] = [
  {
    id: "001_init",
    sql: `
      create table if not exists history_actions (
        id text primary key,
        created_at text not null default (datetime('now')),
        action_type text not null,
        payload_json text not null,
        inverse_patch_json text
      );

      create table if not exists cache_entities (
        budget_id text not null,
        entity_type text not null,
        entity_id text not null,
        data_json text not null,
        updated_at text not null default (datetime('now')),
        primary key (budget_id, entity_type, entity_id)
      );

      create table if not exists cache_state (
        budget_id text not null,
        resource text not null,
        server_knowledge integer not null,
        updated_at text not null default (datetime('now')),
        primary key (budget_id, resource)
      );
    `,
  },
];

export function applyMigrations(db: Database): void {
  db.exec(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at text not null default (datetime('now'))
    );
  `);
  db.exec(`
    create table if not exists schema_version (
      id integer primary key check (id = 1),
      version text not null
    );
  `);

  const existingVersion = db
    .query<{ version: string }, []>("select version from schema_version where id = 1")
    .get();
  if (!existingVersion) {
    const lastApplied = db
      .query<{ id: string }, []>("select id from schema_migrations order by id desc limit 1")
      .get();
    db.query("insert into schema_version (id, version) values (1, ?)").run(lastApplied?.id ?? "0");
  }

  const applied = new Set<string>();
  const rows = db.query<{ id: string }, []>("select id from schema_migrations").all();
  for (const row of rows) {
    applied.add(row.id);
  }

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.exec("begin");
    try {
      db.exec(migration.sql);
      db.query("insert into schema_migrations (id) values (?)").run(migration.id);
      db.query("update schema_version set version = ? where id = 1").run(migration.id);
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
  }
}
