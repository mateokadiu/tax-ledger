import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { split } from '@tax-ledger/core';
import { toTaxInput, StripeTaxCalculationSchema } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, 'fixtures', name);
const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(fixturePath(name), 'utf8'));

describe('StripeTaxCalculationSchema', () => {
  it('parses a canonical WA two-line calculation', () => {
    const raw = loadFixture('wa-two-line.json');
    const parsed = StripeTaxCalculationSchema.parse(raw);
    expect(parsed.id).toBe('taxcalc_1234567');
    expect(parsed.tax_amount_exclusive).toBe(622);
    expect(parsed.line_items).toHaveLength(2);
  });

  it('accepts both the wrapped list and bare array forms of line_items', () => {
    const raw = loadFixture('wa-two-line.json') as { line_items: { data: unknown[] } };
    const bare = { ...raw, line_items: raw.line_items.data };
    const parsed = StripeTaxCalculationSchema.parse(bare);
    expect(parsed.line_items).toHaveLength(2);
  });

  it('parses an EU VAT calculation with country-level jurisdiction', () => {
    const parsed = StripeTaxCalculationSchema.parse(loadFixture('de-vat-line.json'));
    expect(parsed.currency).toBe('eur');
    expect(parsed.shipping_cost).toBeNull();
  });
});

describe('toTaxInput()', () => {
  it('maps the WA two-line calculation into a TaxInput', () => {
    const input = toTaxInput(loadFixture('wa-two-line.json'));
    expect(input.orderId).toBe('taxcalc_1234567');
    expect(input.engineRef).toBe('taxcalc_1234567');
    expect(input.currency).toBe('USD');
    expect(input.totalTaxCents).toBe(622);
    expect(input.lines).toHaveLength(2);
  });

  it('uses `reference` as the lineItemId by default', () => {
    const input = toTaxInput(loadFixture('wa-two-line.json'));
    expect(input.lines.map((l) => l.lineItemId)).toEqual(['A', 'B']);
  });

  it('produces one tax row per breakdown entry', () => {
    const input = toTaxInput(loadFixture('wa-two-line.json'));
    const lineA = input.lines[0]!;
    expect(lineA.taxes).toHaveLength(3);
    const tiers = lineA.taxes.map((t) => t.jurisdiction.type).sort();
    expect(tiers).toEqual(['city', 'county', 'state']);
    expect(lineA.taxes.find((t) => t.jurisdiction.type === 'state')?.amountCents).toBe(325);
  });

  it('encodes a stable jurisdiction code per tier', () => {
    const input = toTaxInput(loadFixture('wa-two-line.json'));
    const lineA = input.lines[0]!;
    const state = lineA.taxes.find((t) => t.jurisdiction.type === 'state');
    const county = lineA.taxes.find((t) => t.jurisdiction.type === 'county');
    const city = lineA.taxes.find((t) => t.jurisdiction.type === 'city');
    expect(state?.jurisdiction.code).toBe('WA');
    expect(county?.jurisdiction.code).toBe('WA-KING');
    expect(city?.jurisdiction.code).toBe('WA-SEATTLE');
  });

  it('roundtrips through split() with no engine drift', () => {
    const input = toTaxInput(loadFixture('wa-two-line.json'));
    const ledger = split(input);
    const taxSum = ledger.rows
      .filter((r) => r.taxType !== 'bottle_deposit')
      .reduce((a, r) => a + r.amountCents, 0);
    expect(taxSum).toBe(622);
  });

  it('maps EU VAT tax_type to taxType: additional with country jurisdiction', () => {
    const input = toTaxInput(loadFixture('de-vat-line.json'));
    expect(input.currency).toBe('EUR');
    expect(input.totalTaxCents).toBe(1900);
    const lineA = input.lines[0]!;
    expect(lineA.taxes).toHaveLength(1);
    const row = lineA.taxes[0]!;
    expect(row.jurisdiction).toEqual({ type: 'country', code: 'DE' });
    expect(row.taxType).toBe('additional');
  });

  it('emits a shipping fee with non-zero amount, skipping zero-tax breakdowns', () => {
    const input = toTaxInput(loadFixture('wa-two-line.json'));
    expect(input.fees).toHaveLength(1);
    expect(input.fees?.[0]?.feeKind).toBe('shipping');
    expect(input.fees?.[0]?.amountCents).toBe(500);
    // The fixture's only shipping breakdown is amount=0 — should not be emitted.
    expect(input.fees?.[0]?.taxes ?? []).toEqual([]);
  });

  it('omits shipping fee entirely when shipping_cost is null', () => {
    const input = toTaxInput(loadFixture('de-vat-line.json'));
    expect(input.fees ?? []).toEqual([]);
  });

  it('respects orderId + engineRef overrides', () => {
    const input = toTaxInput(loadFixture('wa-two-line.json'), {
      orderId: 'merchant_42',
      engineRef: 'engine_42',
    });
    expect(input.orderId).toBe('merchant_42');
    expect(input.engineRef).toBe('engine_42');
  });

  it('respects feeKindForShipping override', () => {
    const input = toTaxInput(loadFixture('wa-two-line.json'), {
      feeKindForShipping: 'fulfillment',
    });
    expect(input.fees?.[0]?.feeKind).toBe('fulfillment');
  });

  it('respects custom lineItemIdResolver', () => {
    const input = toTaxInput(loadFixture('wa-two-line.json'), {
      lineItemIdResolver: ({ index }) => `pos_${index}`,
    });
    expect(input.lines.map((l) => l.lineItemId)).toEqual(['pos_0', 'pos_1']);
  });

  it('throws on a non-conformant Stripe response', () => {
    expect(() => toTaxInput({ object: 'tax.calculation' })).toThrow();
  });
});
