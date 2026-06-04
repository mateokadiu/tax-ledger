/**
 * Opinionated Drizzle ORM adapter for `@tax-ledger/core`.
 *
 * Two parallel schema modules — one for Postgres, one for SQLite — share
 * column names and shapes. Pick the matching import path for your driver.
 *
 *   import { taxLedgerEntries, taxLedgerDeltas } from '@tax-ledger/drizzle/pg';
 *   import { taxLedgerEntries, taxLedgerDeltas } from '@tax-ledger/drizzle/sqlite';
 *
 * The default export bundles both schemas under namespaces for explicit
 * disambiguation in mixed-dialect monorepos.
 */
export * as pg from './schema-pg.js';
export * as sqlite from './schema-sqlite.js';
