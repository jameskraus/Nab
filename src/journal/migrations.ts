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
    `,
  },
  {
    id: "002_ref_lease",
    sql: `
      create table if not exists ref_lease (
        n integer primary key autoincrement,
        uuid text not null unique,
        assigned_at_ms integer not null,
        last_used_at_ms integer not null,
        expires_at_ms integer not null
      );

      create index if not exists idx_ref_lease_expires
      on ref_lease(expires_at_ms);
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
