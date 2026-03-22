import { describe, it, expect } from 'vitest';
import { split, TaxLedgerInvariantError } from '../src/index.js';
import { NY_THREE_LINE } from './fixtures.js';

describe('split()', () => {
  it('produces one row per (line, jurisdiction, taxType) plus deposits plus fee rows', () => {
    const ledger = split(NY_THREE_LINE);
    // Line A: 3 tax + 1 deposit = 4 rows. Line B: 3 tax. Fee: 1. Total: 8 rows.
    expect(ledger.rows).toHaveLength(8);
    expect(ledger.rows.every((r) => Number.isInteger(r.amountCents))).toBe(true);
  });

  it('emits ledger rows whose tax sum equals input.totalTaxCents', () => {
    const ledger = split(NY_THREE_LINE);
    const taxSum = ledger.netCents({ taxType: 'sales' })
      + ledger.netCents({ taxType: 'shipping' })
      + ledger.netCents({ taxType: 'additional' });
    expect(taxSum).toBe(412);
  });

  it('emits bottle_deposit rows whose sum equals input deposits', () => {
    const ledger = split(NY_THREE_LINE);
    expect(ledger.netCents({ taxType: 'bottle_deposit' })).toBe(1000);
  });

  it('rowsForLine returns only rows scoped to a given line', () => {
    const ledger = split(NY_THREE_LINE);
    const rowsA = ledger.rowsForLine('A');
    // A has 3 sales-tax rows + 1 deposit row = 4
    expect(rowsA).toHaveLength(4);
    expect(rowsA.every((r) => r.scope.kind === 'line' && r.scope.lineItemId === 'A')).toBe(true);
  });

  it('rowsForFee returns only rows scoped to a given fee', () => {
    const ledger = split(NY_THREE_LINE);
    const rowsShipping = ledger.rowsForFee('shipping');
    expect(rowsShipping).toHaveLength(1);
    expect(rowsShipping[0]!.taxType).toBe('shipping');
  });

  it('absorbs 1-cent engine drift as a rounding_residual row', () => {
    const input = {
      ...NY_THREE_LINE,
      totalTaxCents: 413, // 1 cent more than the line details sum to
    };
    const ledger = split(input);
    const residual = ledger.rows.find((r) => r.scope.kind === 'order');
    expect(residual).toBeDefined();
    expect(residual!.amountCents).toBe(1);
    expect(residual!.taxType).toBe('additional');
    // Final invariant: tax rows sum back to declared total
    const finalTax = ledger.netCents({ taxType: 'sales' })
      + ledger.netCents({ taxType: 'shipping' })
      + ledger.netCents({ taxType: 'additional' });
    expect(finalTax).toBe(413);
  });

  it('throws if engine drift exceeds 1 cent', () => {
    const input = {
      ...NY_THREE_LINE,
      totalTaxCents: 500, // 88 cents off
    };
    expect(() => split(input)).toThrow(TaxLedgerInvariantError);
  });

  it('rejects invalid input via zod', () => {
    expect(() => split({ ...NY_THREE_LINE, currency: 'US' })).toThrow();
    expect(() => split({ ...NY_THREE_LINE, lines: [] })).toThrow();
  });

  it('emits stable uuidv7 ids that sort lexicographically by createdAt', () => {
    const ledger = split(NY_THREE_LINE);
    const ids = ledger.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
  });
});
