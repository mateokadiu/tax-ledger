import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { Ledger, split, refund, type TaxInput } from '@tax-ledger/core';
import {
  applyDelta,
  generateMigration,
  persistLedger,
  sqlite as sqliteSchema,
  toEntryRow,
} from '../src/index.js';

const NY: TaxInput = {
  orderId: 'order_drizzle_001',
  currency: 'USD',
  engineRef: 'avalara_drz_001',
  totalTaxCents: 412,
  lines: [
    {
      lineItemId: 'A',
      quantity: 2,
      unitAmountCents: 2499,
      taxes: [
        { jurisdiction: { type: 'state', code: 'NY' }, taxType: 'sales', amountCents: 150 },
        { jurisdiction: { type: 'county', code: 'NY-NYC' }, taxType: 'sales', amountCents: 45 },
        { jurisdiction: { type: 'city', code: 'NY-NYC' }, taxType: 'sales', amountCents: 36 },
      ],
      deposits: [
        { jurisdiction: { type: 'state', code: 'NY' }, amountCents: 1000 },
      ],
    },
    {
      lineItemId: 'B',
      quantity: 1,
      unitAmountCents: 1999,
      taxes: [
        { jurisdiction: { type: 'state', code: 'NY' }, taxType: 'sales', amountCents: 120 },
        { jurisdiction: { type: 'county', code: 'NY-NYC' }, taxType: 'sales', amountCents: 36 },
        { jurisdiction: { type: 'city', code: 'NY-NYC' }, taxType: 'sales', amountCents: 22 },
      ],
    },
  ],
  fees: [
    {
      feeKind: 'shipping',
      amountCents: 652,
      taxes: [{ jurisdiction: { type: 'state', code: 'NY' }, taxType: 'shipping', amountCents: 3 }],
    },
  ],
};

function makeDb(): BetterSQLite3Database {
  const sqlite = new Database(':memory:');
  const { up } = generateMigration('sqlite');
  sqlite.exec(up);
  return drizzle(sqlite);
}

describe('generateMigration()', () => {
  it('emits sqlite DDL that runs cleanly on better-sqlite3', () => {
    const sqlite = new Database(':memory:');
    const { up } = generateMigration('sqlite');
    expect(() => sqlite.exec(up)).not.toThrow();
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(['tax_ledger_deltas', 'tax_ledger_entries']);
  });

  it('the down migration cleans tables fully', () => {
    const sqlite = new Database(':memory:');
    const { up, down } = generateMigration('sqlite');
    sqlite.exec(up);
    sqlite.exec(down);
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables).toEqual([]);
  });

  it('emits valid pg DDL (round-trip of the strings is non-empty + contains the table names)', () => {
    const { up, down } = generateMigration('pg');
    expect(up).toContain('CREATE TABLE IF NOT EXISTS tax_ledger_entries');
    expect(up).toContain('CREATE TABLE IF NOT EXISTS tax_ledger_deltas');
    expect(up).toContain('JSONB');
    expect(down).toContain('DROP TABLE IF EXISTS tax_ledger_entries');
  });
});

describe('persistLedger()', () => {
  let db: BetterSQLite3Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('inserts every ledger row', async () => {
    const ledger = split(NY);
    await persistLedger(db, ledger, { dialect: 'sqlite' });

    const all = db.select().from(sqliteSchema.taxLedgerEntries).all();
    expect(all).toHaveLength(ledger.rows.length);
    const sum = all.reduce((a, r) => a + Number(r.amountCents), 0);
    const ledgerSum = ledger.rows.reduce((a, r) => a + r.amountCents, 0);
    expect(sum).toBe(ledgerSum);
  });

  it('no-ops when the ledger has zero rows', async () => {
    const empty = new Ledger('order_empty', 'USD', []);
    await persistLedger(db, empty, { dialect: 'sqlite' });
    const all = db.select().from(sqliteSchema.taxLedgerEntries).all();
    expect(all).toHaveLength(0);
  });

  it('preserves scope + origin JSON shape', async () => {
    const ledger = split(NY);
    await persistLedger(db, ledger, { dialect: 'sqlite' });
    const rows = db.select().from(sqliteSchema.taxLedgerEntries).all();
    const lineA = rows.find((r) => {
      const scope = r.scope as { kind: string; lineItemId?: string };
      return scope.kind === 'line' && scope.lineItemId === 'A';
    });
    expect(lineA).toBeDefined();
    expect((lineA!.origin as { kind: string }).kind).toBe('split');
    expect(lineA!.currency).toBe('USD');
  });

  it('persists the line quantity + nullable engine columns', async () => {
    const ledger = split(NY);
    await persistLedger(db, ledger, { dialect: 'sqlite' });
    const rows = db.select().from(sqliteSchema.taxLedgerEntries).all();
    const lineA = rows.find((r) => {
      const scope = r.scope as { kind: string; lineItemId?: string };
      return scope.kind === 'line' && scope.lineItemId === 'A';
    })!;
    expect(lineA.quantity).toBe(2);
    expect(lineA.taxCode).toBeNull(); // NY fixture carries no tax_code
  });
});

describe('applyDelta()', () => {
  let db: BetterSQLite3Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('persists delta entries + writes the cross-reference rows', async () => {
    const ledger = split(NY);
    await persistLedger(db, ledger, { dialect: 'sqlite' });

    const delta = refund(ledger, {
      refundId: 'rf_drz_1',
      lines: [{ lineItemId: 'A', amountCents: 100 }],
    });
    expect(delta.length).toBeGreaterThan(0);
    const originalId = ledger.rows[0]!.id;

    await applyDelta(db, originalId, delta, { dialect: 'sqlite' });

    const entryRows = db.select().from(sqliteSchema.taxLedgerEntries).all();
    expect(entryRows).toHaveLength(ledger.rows.length + delta.length);

    const linkRows = db.select().from(sqliteSchema.taxLedgerDeltas).all();
    expect(linkRows).toHaveLength(delta.length);
    expect(linkRows.every((r) => r.originalId === originalId)).toBe(true);
    expect(linkRows.every((r) => r.relation === 'refund')).toBe(true);
  });

  it('per-row delta cents sum to -refund total', async () => {
    const ledger = split(NY);
    await persistLedger(db, ledger, { dialect: 'sqlite' });

    const delta = refund(ledger, {
      refundId: 'rf_drz_sum',
      lines: [{ lineItemId: 'A', amountCents: 600 }],
    });
    await applyDelta(db, ledger.rows[0]!.id, delta, { dialect: 'sqlite' });

    const persistedDeltas = db
      .select()
      .from(sqliteSchema.taxLedgerEntries)
      .where(eq(sqliteSchema.taxLedgerEntries.orderId, 'order_drizzle_001'))
      .all()
      .filter((r) => {
        const origin = r.origin as { kind: string };
        return origin.kind === 'refund';
      });
    const sum = persistedDeltas.reduce((a, r) => a + Number(r.amountCents), 0);
    expect(sum).toBe(-600);
  });

  it('respects an explicit relation override', async () => {
    const ledger = split(NY);
    await persistLedger(db, ledger, { dialect: 'sqlite' });

    const delta = refund(ledger, {
      refundId: 'rf_drz_relate',
      lines: [{ lineItemId: 'A', amountCents: 50 }],
    });
    await applyDelta(db, ledger.rows[0]!.id, delta, {
      dialect: 'sqlite',
      relation: 'partial_correction',
    });

    const links = db.select().from(sqliteSchema.taxLedgerDeltas).all();
    expect(links.every((r) => r.relation === 'partial_correction')).toBe(true);
  });
});

describe('toEntryRow()', () => {
  it('projects a LedgerEntry into the schema row shape', () => {
    const ledger = split(NY);
    const row = toEntryRow(ledger.rows[0]!);
    expect(row).toHaveProperty('orderId');
    expect(row).toHaveProperty('jurisdictionType');
    expect(row).toHaveProperty('amountCents');
    expect(row).toHaveProperty('createdAt');
  });
});
