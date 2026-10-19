// SQLite persistence (node:sqlite, no native build step). The schema is kept
// portable to PostgreSQL: plain tables, integer money, epoch-ms timestamps.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  `CREATE TABLE players (
     id TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     balance INTEGER NOT NULL CHECK (balance >= 0),
     created_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     pos_x REAL, pos_y REAL, pos_z REAL, heading REAL
   );
   CREATE TABLE leases (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     region TEXT NOT NULL,
     building_id TEXT NOT NULL,
     player_id TEXT NOT NULL REFERENCES players(id),
     monthly_rent INTEGER NOT NULL,
     started_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
     ended_at INTEGER,
     end_reason TEXT,
     custom_name TEXT
   );
   -- At most one active lease per building: the database itself rejects double rentals.
   CREATE UNIQUE INDEX leases_one_active ON leases(building_id) WHERE status = 'active';
   CREATE INDEX leases_by_player ON leases(player_id, status);
   CREATE INDEX leases_by_expiry ON leases(status, expires_at);
   CREATE TABLE ledger (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     player_id TEXT NOT NULL REFERENCES players(id),
     amount INTEGER NOT NULL,
     balance_after INTEGER NOT NULL,
     kind TEXT NOT NULL,
     building_id TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX ledger_by_player ON ledger(player_id, created_at);`,
  // v2: statewide buildings — remember where a leased building is.
  `ALTER TABLE leases ADD COLUMN tile TEXT;
   ALTER TABLE leases ADD COLUMN building_name TEXT;
   ALTER TABLE leases ADD COLUMN cx REAL;
   ALTER TABLE leases ADD COLUMN cy REAL;`,
];

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.exec('INSERT INTO schema_version (version) VALUES (0)');
  for (; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

/** Run fn inside an IMMEDIATE transaction (takes the write lock up front). */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
