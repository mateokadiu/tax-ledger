import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  timestamp,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle schema for the tax ledger on Postgres.
 *
 *  - `tax_ledger_entries`: every emitted ledger entry — split-origin rows,
 *    refund deltas, capture deltas, revision deltas. Append-only;
 *    re-application is idempotent on (order_id, id).
 *  - `tax_ledger_deltas`: cross-reference index linking a delta entry back
 *    to its originating split entry. Optional; populated only by
 *    `applyDelta(db, originalId, delta)` for adjustments that target a
 *    specific prior row (refund-by-row, partial-correction).
 *
 * Notes:
 *  - `amount_cents` is signed; deltas are negative.
 *  - `scope`, `jurisdiction`, `origin` carry the discriminated-union JSON
 *    blobs verbatim from the core. `jsonb` keeps them queryable.
 *  - `currency` is stored uppercase ISO-4217 (3 chars). Mixing currencies
 *    in one logical ledger is a domain error — the engine refuses it.
 */

export const taxLedgerEntries = pgTable(
  'tax_ledger_entries',
  {
    id: text('id').primaryKey().notNull(),
    orderId: text('order_id').notNull(),
    currency: text('currency').notNull(),
    scope: jsonb('scope').$type<Record<string, unknown>>().notNull(),
    jurisdictionType: text('jurisdiction_type').notNull(),
    jurisdictionCode: text('jurisdiction_code').notNull(),
    taxType: text('tax_type').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    taxCode: text('tax_code'),
    taxBehavior: text('tax_behavior'),
    engineTaxType: text('engine_tax_type'),
    quantity: integer('quantity'),
    origin: jsonb('origin').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    orderIdx: index('tax_ledger_entries_order_idx').on(t.orderId as AnyPgColumn),
    orderCurrencyIdx: index('tax_ledger_entries_order_currency_idx').on(
      t.orderId as AnyPgColumn,
      t.currency as AnyPgColumn,
    ),
    jurisdictionIdx: index('tax_ledger_entries_juris_idx').on(
      t.jurisdictionType as AnyPgColumn,
      t.jurisdictionCode as AnyPgColumn,
    ),
  }),
);
export type TaxLedgerEntryRow = typeof taxLedgerEntries.$inferSelect;
export type NewTaxLedgerEntryRow = typeof taxLedgerEntries.$inferInsert;

export const taxLedgerDeltas = pgTable(
  'tax_ledger_deltas',
  {
    id: text('id').primaryKey().notNull(),
    originalId: text('original_id')
      .notNull()
      .references(() => taxLedgerEntries.id, { onDelete: 'restrict' }),
    deltaId: text('delta_id')
      .notNull()
      .references(() => taxLedgerEntries.id, { onDelete: 'restrict' }),
    relation: text('relation').notNull(),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    originalIdx: index('tax_ledger_deltas_original_idx').on(t.originalId as AnyPgColumn),
    deltaIdx: index('tax_ledger_deltas_delta_idx').on(t.deltaId as AnyPgColumn),
  }),
);
export type TaxLedgerDeltaRow = typeof taxLedgerDeltas.$inferSelect;
export type NewTaxLedgerDeltaRow = typeof taxLedgerDeltas.$inferInsert;
