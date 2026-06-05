/**
 * Opinionated Drizzle ORM adapter for `@tax-ledger/core`.
 *
 * Two parallel schema modules — one for Postgres, one for SQLite — share
 * column names and shapes. Pick the matching import path for your driver.
 *
 * The persistence helpers (`persistLedger`, `applyDelta`) accept either
 * dialect's Drizzle instance: pass `dialect: 'sqlite'` when you're on
 * SQLite, omit it for the default PG dialect.
 */
export * as pg from './schema-pg.js';
export * as sqlite from './schema-sqlite.js';
export {
  persistLedger,
  applyDelta,
  toEntryRow,
  type Dialect,
  type InsertableDb,
} from './persist.js';
export { generateMigration, type MigrationSql } from './migrations.js';
