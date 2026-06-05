/**
 * DDL migration generator for the tax-ledger schema. Returns the raw SQL
 * for either dialect, suitable for handing to your migration runner
 * (drizzle-kit, Atlas, raw `db.exec`, etc.) verbatim.
 *
 * The shape mirrors the Drizzle schema modules — column names, types, and
 * indices match exactly.
 */

import type { Dialect } from './persist.js';

export interface MigrationSql {
  up: string;
  down: string;
}

const PG_UP = `CREATE TABLE IF NOT EXISTS tax_ledger_entries (
  id                 TEXT PRIMARY KEY NOT NULL,
  order_id           TEXT NOT NULL,
  currency           TEXT NOT NULL,
  scope              JSONB NOT NULL,
  jurisdiction_type  TEXT NOT NULL,
  jurisdiction_code  TEXT NOT NULL,
  tax_type           TEXT NOT NULL,
  amount_cents       BIGINT NOT NULL,
  origin             JSONB NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS tax_ledger_entries_order_idx
  ON tax_ledger_entries (order_id);

CREATE INDEX IF NOT EXISTS tax_ledger_entries_order_currency_idx
  ON tax_ledger_entries (order_id, currency);

CREATE INDEX IF NOT EXISTS tax_ledger_entries_juris_idx
  ON tax_ledger_entries (jurisdiction_type, jurisdiction_code);

CREATE TABLE IF NOT EXISTS tax_ledger_deltas (
  id           TEXT PRIMARY KEY NOT NULL,
  original_id  TEXT NOT NULL REFERENCES tax_ledger_entries (id) ON DELETE RESTRICT,
  delta_id     TEXT NOT NULL REFERENCES tax_ledger_entries (id) ON DELETE RESTRICT,
  relation     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS tax_ledger_deltas_original_idx
  ON tax_ledger_deltas (original_id);

CREATE INDEX IF NOT EXISTS tax_ledger_deltas_delta_idx
  ON tax_ledger_deltas (delta_id);
`;

const PG_DOWN = `DROP INDEX IF EXISTS tax_ledger_deltas_delta_idx;
DROP INDEX IF EXISTS tax_ledger_deltas_original_idx;
DROP TABLE IF EXISTS tax_ledger_deltas;

DROP INDEX IF EXISTS tax_ledger_entries_juris_idx;
DROP INDEX IF EXISTS tax_ledger_entries_order_currency_idx;
DROP INDEX IF EXISTS tax_ledger_entries_order_idx;
DROP TABLE IF EXISTS tax_ledger_entries;
`;

const SQLITE_UP = `CREATE TABLE IF NOT EXISTS tax_ledger_entries (
  id                 TEXT PRIMARY KEY NOT NULL,
  order_id           TEXT NOT NULL,
  currency           TEXT NOT NULL,
  scope              TEXT NOT NULL,
  jurisdiction_type  TEXT NOT NULL,
  jurisdiction_code  TEXT NOT NULL,
  tax_type           TEXT NOT NULL,
  amount_cents       INTEGER NOT NULL,
  origin             TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS tax_ledger_entries_order_idx
  ON tax_ledger_entries (order_id);

CREATE INDEX IF NOT EXISTS tax_ledger_entries_order_currency_idx
  ON tax_ledger_entries (order_id, currency);

CREATE INDEX IF NOT EXISTS tax_ledger_entries_juris_idx
  ON tax_ledger_entries (jurisdiction_type, jurisdiction_code);

CREATE TABLE IF NOT EXISTS tax_ledger_deltas (
  id           TEXT PRIMARY KEY NOT NULL,
  original_id  TEXT NOT NULL REFERENCES tax_ledger_entries (id) ON DELETE RESTRICT,
  delta_id     TEXT NOT NULL REFERENCES tax_ledger_entries (id) ON DELETE RESTRICT,
  relation     TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS tax_ledger_deltas_original_idx
  ON tax_ledger_deltas (original_id);

CREATE INDEX IF NOT EXISTS tax_ledger_deltas_delta_idx
  ON tax_ledger_deltas (delta_id);
`;

const SQLITE_DOWN = `DROP INDEX IF EXISTS tax_ledger_deltas_delta_idx;
DROP INDEX IF EXISTS tax_ledger_deltas_original_idx;
DROP TABLE IF EXISTS tax_ledger_deltas;

DROP INDEX IF EXISTS tax_ledger_entries_juris_idx;
DROP INDEX IF EXISTS tax_ledger_entries_order_currency_idx;
DROP INDEX IF EXISTS tax_ledger_entries_order_idx;
DROP TABLE IF EXISTS tax_ledger_entries;
`;

/**
 * Generate up + down DDL for the given dialect. Down is the inverse of up;
 * apply in reverse order to roll the tables out cleanly.
 *
 *   const { up } = generateMigration('pg');
 *   await db.execute(sql.raw(up));
 */
export function generateMigration(dialect: Dialect): MigrationSql {
  if (dialect === 'sqlite') {
    return { up: SQLITE_UP, down: SQLITE_DOWN };
  }
  return { up: PG_UP, down: PG_DOWN };
}
