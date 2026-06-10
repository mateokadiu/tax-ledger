import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

/**
 * SQLite-compatible mirror of the Postgres schema. SQLite has no jsonb;
 * we store scope/origin as JSON text. amount_cents stays a 64-bit integer
 * — SQLite's native INTEGER is large enough for any realistic cents total.
 *
 * Column names match the PG schema so migrations can be expressed in
 * shared DDL files when feasible.
 */

export const taxLedgerEntries = sqliteTable(
  'tax_ledger_entries',
  {
    id: text('id').primaryKey().notNull(),
    orderId: text('order_id').notNull(),
    currency: text('currency').notNull(),
    scope: text('scope', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    jurisdictionType: text('jurisdiction_type').notNull(),
    jurisdictionCode: text('jurisdiction_code').notNull(),
    taxType: text('tax_type').notNull(),
    amountCents: integer('amount_cents').notNull(),
    taxCode: text('tax_code'),
    taxBehavior: text('tax_behavior'),
    engineTaxType: text('engine_tax_type'),
    quantity: integer('quantity'),
    origin: text('origin', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    orderIdx: index('tax_ledger_entries_order_idx').on(t.orderId),
    orderCurrencyIdx: index('tax_ledger_entries_order_currency_idx').on(t.orderId, t.currency),
    jurisdictionIdx: index('tax_ledger_entries_juris_idx').on(t.jurisdictionType, t.jurisdictionCode),
  }),
);
export type TaxLedgerEntryRow = typeof taxLedgerEntries.$inferSelect;
export type NewTaxLedgerEntryRow = typeof taxLedgerEntries.$inferInsert;

export const taxLedgerDeltas = sqliteTable(
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
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    originalIdx: index('tax_ledger_deltas_original_idx').on(t.originalId),
    deltaIdx: index('tax_ledger_deltas_delta_idx').on(t.deltaId),
  }),
);
export type TaxLedgerDeltaRow = typeof taxLedgerDeltas.$inferSelect;
export type NewTaxLedgerDeltaRow = typeof taxLedgerDeltas.$inferInsert;
