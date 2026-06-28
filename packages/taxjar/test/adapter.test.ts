import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { split } from '@tax-ledger/core';
import {
  toTaxInput,
  TaxJarTaxResponseSchema,
  type TaxJarLineMeta,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, 'fixtures', name);
const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(fixturePath(name), 'utf8'));

describe('TaxJarTaxResponseSchema', () => {
  it('parses a canonical CA two-line response', () => {
    const raw = loadFixture('ca-two-line.json');
    const parsed = TaxJarTaxResponseSchema.parse(raw);
    expect(parsed.tax.amount_to_collect).toBeCloseTo(6.21);
    expect(parsed.tax.breakdown?.line_items).toHaveLength(2);
  });

  it('rejects a response missing the tax envelope', () => {
    expect(() => TaxJarTaxResponseSchema.parse({})).toThrow();
  });
});

describe('toTaxInput()', () => {
  const lineItems: ReadonlyArray<TaxJarLineMeta> = [
    { id: 'A', quantity: 2, unitAmountCents: 2499 },
    { id: 'B', quantity: 1, unitAmountCents: 2315 },
  ];

  it('maps a CA two-line response into a TaxInput', () => {
    const input = toTaxInput(loadFixture('ca-two-line.json'), {
      orderId: 'order_ca_001',
      lineItems,
      shippingFeeAmountCents: 500,
    });
    expect(input.orderId).toBe('order_ca_001');
    expect(input.engineRef).toBe('order_ca_001');
    expect(input.currency).toBe('USD');
    expect(input.totalTaxCents).toBe(621);
    expect(input.lines).toHaveLength(2);
  });

  it('emits per-jurisdiction rows on each line (state + county + special, no city)', () => {
    const input = toTaxInput(loadFixture('ca-two-line.json'), {
      orderId: 'order_ca_001',
      lineItems,
    });
    const lineA = input.lines.find((l) => l.lineItemId === 'A')!;
    expect(lineA.taxes).toHaveLength(3); // city_amount == 0 → skipped
    const tiers = lineA.taxes.map((t) => t.jurisdiction.type).sort();
    expect(tiers).toEqual(['county', 'special', 'state']);
    expect(lineA.taxes.find((t) => t.jurisdiction.type === 'state')?.amountCents).toBe(312);
    expect(lineA.taxes.find((t) => t.jurisdiction.type === 'county')?.amountCents).toBe(12);
    expect(lineA.taxes.find((t) => t.jurisdiction.type === 'special')?.amountCents).toBe(100);
  });

  it('roundtrips through split() — sums match the engine total to the cent', () => {
    const input = toTaxInput(loadFixture('ca-two-line.json'), {
      orderId: 'order_ca_001',
      lineItems,
      shippingFeeAmountCents: 500,
    });
    const ledger = split(input);
    const taxSum = ledger.rows
      .filter((r) => r.taxType !== 'bottle_deposit')
      .reduce((a, r) => a + r.amountCents, 0);
    expect(taxSum).toBe(621);
  });

  it('handles a fully-exempt line — zero tax rows', () => {
    const input = toTaxInput(loadFixture('exempt-line.json'), {
      orderId: 'order_exempt',
      lineItems: [{ id: 'A', quantity: 1, unitAmountCents: 5000 }],
    });
    expect(input.totalTaxCents).toBe(0);
    expect(input.lines).toHaveLength(1);
    expect(input.lines[0]?.taxes).toEqual([]);
    expect(input.fees ?? []).toEqual([]);
  });

  it('skips free shipping (no fee row emitted)', () => {
    const input = toTaxInput(loadFixture('free-shipping.json'), {
      orderId: 'order_free_ship',
      lineItems: [{ id: 'A', quantity: 1, unitAmountCents: 2499 }],
    });
    expect(input.fees ?? []).toEqual([]);
  });

  it('includes lines that TaxJar omits from breakdown.line_items', () => {
    // Fixture has only line A; we supply metadata for A and B.
    const input = toTaxInput(loadFixture('free-shipping.json'), {
      orderId: 'order_complete',
      lineItems: [
        { id: 'A', quantity: 1, unitAmountCents: 2499 },
        { id: 'B', quantity: 1, unitAmountCents: 100 },
      ],
    });
    expect(input.lines).toHaveLength(2);
    const lineB = input.lines.find((l) => l.lineItemId === 'B')!;
    expect(lineB.taxes).toEqual([]);
  });

  it('throws if a breakdown line has no matching metadata', () => {
    expect(() =>
      toTaxInput(loadFixture('ca-two-line.json'), {
        orderId: 'order_missing_meta',
        lineItems: [{ id: 'A', quantity: 2, unitAmountCents: 2499 }],
      }),
    ).toThrow(/no line metadata supplied for breakdown line id="B"/);
  });

  it('respects custom currency option', () => {
    const input = toTaxInput(loadFixture('ca-two-line.json'), {
      orderId: 'order_eur_attempt',
      currency: 'eur',
      lineItems,
    });
    expect(input.currency).toBe('EUR');
  });

  it('respects jurisdictionCodes overrides', () => {
    const input = toTaxInput(loadFixture('ca-two-line.json'), {
      orderId: 'order_codes',
      lineItems,
      jurisdictionCodes: { state: 'CA', county: 'ALA', city: 'OAK', special: 'BART' },
    });
    const lineA = input.lines.find((l) => l.lineItemId === 'A')!;
    const special = lineA.taxes.find((t) => t.jurisdiction.type === 'special');
    expect(special?.jurisdiction.code).toBe('BART');
  });

  it('preserves caller-supplied deposits on a line', () => {
    const input = toTaxInput(loadFixture('ca-two-line.json'), {
      orderId: 'order_deposits',
      lineItems: [
        {
          id: 'A',
          quantity: 2,
          unitAmountCents: 2499,
          deposits: [
            { jurisdiction: { type: 'state', code: 'CA' }, amountCents: 1000 },
          ],
        },
        { id: 'B', quantity: 1, unitAmountCents: 2315 },
      ],
    });
    const lineA = input.lines.find((l) => l.lineItemId === 'A')!;
    expect(lineA.deposits).toHaveLength(1);
    expect(lineA.deposits?.[0]?.amountCents).toBe(1000);
  });
});
