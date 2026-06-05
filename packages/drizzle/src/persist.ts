import type { Ledger, LedgerEntry } from '@tax-ledger/core';
import { uuidv7 } from '@tax-ledger/core';
import * as pgSchema from './schema-pg.js';
import * as sqliteSchema from './schema-sqlite.js';

/**
 * Bound persistence interface. We don't depend on a specific Drizzle dialect
 * driver here — callers pass either a PG or SQLite Drizzle instance and the
 * corresponding schema bundle. The helpers project the core's ledger
 * entries into the schema's row shape and INSERT them in a single batch
 * (or a transaction when supported).
 */

export type Dialect = 'pg' | 'sqlite';

export interface InsertableDb {
  insert(table: unknown): {
    values(rows: ReadonlyArray<Record<string, unknown>>): {
      returning?: () => Promise<unknown[]>;
      onConflictDoNothing?: () => { returning?: () => Promise<unknown[]> };
    };
  };
}

export interface InsertableDbWithRun extends InsertableDb {
  // better-sqlite3 / pg both expose `await ... insert(...).values(...)`
  // and we Promise.resolve() the inserted statement to await either form.
}

/**
 * Project a single LedgerEntry into the schema's row shape (column → value).
 * Schema is the same shape on PG and SQLite at the runtime-row layer because
 * the columns share names; the type-level differences live in jsonb vs
 * text-json.
 */
export function toEntryRow(
  entry: LedgerEntry,
): Record<string, unknown> {
  return {
    id: entry.id,
    order_id: entry.orderId,
    currency: entry.currency,
    scope: entry.scope,
    jurisdiction_type: entry.jurisdiction.type,
    jurisdiction_code: entry.jurisdiction.code,
    tax_type: entry.taxType,
    amount_cents: entry.amountCents,
    origin: entry.origin,
    created_at: entry.createdAt,
  };
}

interface PersistOptions {
  dialect?: Dialect;
}

/**
 * Persist a `Ledger` to a Drizzle-bound database.
 *
 *   await persistLedger(db, ledger);
 *
 * One INSERT per row, batched into a single statement. Caller controls the
 * transaction — if you pass `db.transaction(async (tx) => persistLedger(tx, ...))`
 * the inserts happen inside the tx automatically.
 *
 * Idempotency: rows have UUIDv7 primary keys. Re-running with the same
 * ledger fails fast on the primary-key collision unless callers wrap with
 * `onConflictDoNothing()` themselves via the lower-level row helpers.
 */
export async function persistLedger(
  db: InsertableDb,
  ledger: Ledger,
  options: PersistOptions = {},
): Promise<void> {
  if (ledger.rows.length === 0) return;
  const table = pickEntriesTable(options.dialect);
  const rows = ledger.rows.map(toEntryRow);
  await Promise.resolve(db.insert(table).values(rows));
}

/**
 * Persist a delta (refund / capture / revision) and record the
 * `originalId → deltaId` cross-reference linking it back to a prior
 * split row. Useful for refund-by-row workflows where the caller knows
 * exactly which split row a delta amends.
 *
 *   await applyDelta(db, originalRowId, deltaEntries);
 *
 * The `delta` array's entries are inserted into `tax_ledger_entries`;
 * one `tax_ledger_deltas` row is emitted per delta entry, all pointing
 * at the same `originalId`.
 */
export async function applyDelta(
  db: InsertableDb,
  originalId: string,
  delta: ReadonlyArray<LedgerEntry>,
  options: PersistOptions & { relation?: string } = {},
): Promise<void> {
  if (delta.length === 0) return;
  const dialect = options.dialect;
  const entriesTable = pickEntriesTable(dialect);
  const deltasTable = pickDeltasTable(dialect);
  const entriesRows = delta.map(toEntryRow);
  await Promise.resolve(db.insert(entriesTable).values(entriesRows));

  const relation = options.relation ?? inferRelation(delta[0]);
  const linkRows = delta.map((d) => ({
    id: uuidv7(),
    original_id: originalId,
    delta_id: d.id,
    relation,
    created_at: d.createdAt,
  }));
  await Promise.resolve(db.insert(deltasTable).values(linkRows));
}

function pickEntriesTable(dialect: Dialect | undefined): unknown {
  return dialect === 'sqlite' ? sqliteSchema.taxLedgerEntries : pgSchema.taxLedgerEntries;
}

function pickDeltasTable(dialect: Dialect | undefined): unknown {
  return dialect === 'sqlite' ? sqliteSchema.taxLedgerDeltas : pgSchema.taxLedgerDeltas;
}

function inferRelation(entry: LedgerEntry | undefined): string {
  if (!entry) return 'unknown';
  return entry.origin.kind;
}
