import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { split } from '@tax-ledger/core';
import { toTaxInput, FonoaCalculationSchema } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8'));

describe('FonoaCalculationSchema', () => {
  it('parses a NL VAT calculation', () => {
    const c = FonoaCalculationSchema.parse(loadFixture('nl-vat-line.json'));
    expect(c.id).toBe('calc_nl_001');
    expect(c.result.items).toHaveLength(1);
  });

  it('rejects a response with no result', () => {
    expect(() => FonoaCalculationSchema.parse({ id: 'x' })).toThrow();
  });
});

describe('toTaxInput()', () => {
  it('maps a Fonoa NL VAT calculation into a TaxInput', () => {
    const input = toTaxInput(loadFixture('nl-vat-line.json'), { currency: 'EUR' });
    expect(input.currency).toBe('EUR');
    expect(input.engineRef).toBe('calc_nl_001');
    expect(input.totalTaxCents).toBe(2100);
    expect(input.lines).toHaveLength(1);

    const row = input.lines[0]!.taxes[0]!;
    expect(row.taxType).toBe('vat');
    expect(row.amountCents).toBe(2100);
    expect(row.engineTaxType).toBe('BTW');
    expect(row.taxBehavior).toBe('exclusive');
    expect(row.jurisdiction).toMatchObject({
      type: 'country',
      code: 'NL',
      country: 'NL',
      name: 'Netherlands',
    });
  });

  it('round-trips through split() with no drift; vat lands in component totals', () => {
    const ledger = split(toTaxInput(loadFixture('nl-vat-line.json'), { currency: 'EUR' }));
    expect(ledger.toComponentTotals().vat).toBe(2100);
  });

  it('honors priceIncludesTax → inclusive behavior', () => {
    const input = toTaxInput(loadFixture('nl-vat-line.json'), {
      currency: 'EUR',
      priceIncludesTax: true,
    });
    expect(input.lines[0]!.taxes[0]!.taxBehavior).toBe('inclusive');
  });

  it('honors per-line quantity (for later quantity refunds)', () => {
    const input = toTaxInput(loadFixture('nl-vat-line.json'), {
      currency: 'EUR',
      lineQuantities: { A: 2 },
    });
    expect(input.lines[0]!.quantity).toBe(2);
  });

  it('treats a reverse-charge / exempt (zero-tax) line as no tax rows', () => {
    const calc = {
      id: 'calc_rc',
      result: {
        total_indirect_tax_amount: 0,
        items: [{ id: 'A', net_amount: 100.0, indirect_tax_amount: 0, tax_breakdown: [] }],
      },
    };
    const input = toTaxInput(calc, { currency: 'EUR' });
    expect(input.totalTaxCents).toBe(0);
    expect(input.lines[0]!.taxes).toHaveLength(0);
    expect(split(input).toComponentTotals().vat).toBe(0);
  });

  it('uppercases currency and defaults orderId/engineRef to the calc id', () => {
    const input = toTaxInput(loadFixture('nl-vat-line.json'), { currency: 'eur' });
    expect(input.currency).toBe('EUR');
    expect(input.orderId).toBe('calc_nl_001');
  });

  it('throws on a non-conformant response', () => {
    expect(() => toTaxInput({ not: 'fonoa' }, { currency: 'EUR' })).toThrow();
  });
});
