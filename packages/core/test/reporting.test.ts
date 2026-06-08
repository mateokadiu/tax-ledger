import { describe, it, expect } from 'vitest';
import { split } from '../src/index.js';
import { NY_THREE_LINE } from './fixtures.js';

describe('Ledger.toComponentTotals()', () => {
  it('buckets net cents into the canonical components', () => {
    const c = split(NY_THREE_LINE).toComponentTotals();
    expect(c).toEqual({
      salesTax: 409, // A: 150+45+36, B: 120+36+22
      shippingTax: 3,
      bottleDeposits: 1000,
      vat: 0,
      additional: 0,
      total: 1412,
    });
  });

  it('total equals the ledger net across every row', () => {
    const ledger = split(NY_THREE_LINE);
    const net = ledger.rows.reduce((a, r) => a + r.amountCents, 0);
    expect(ledger.toComponentTotals().total).toBe(net);
  });
});

describe('Ledger.rollupBy()', () => {
  it('groups by a single dimension and sums', () => {
    const groups = split(NY_THREE_LINE).rollupBy(['taxType']);
    const byType = Object.fromEntries(groups.map((g) => [g.key.taxType, g.amountCents]));
    expect(byType.sales).toBe(409);
    expect(byType.shipping).toBe(3);
    expect(byType.bottle_deposit).toBe(1000);
  });

  it('groups by multiple dimensions and counts rows', () => {
    const groups = split(NY_THREE_LINE).rollupBy(['jurisdictionType', 'taxType']);
    const total = groups.reduce((a, g) => a + g.amountCents, 0);
    const count = groups.reduce((a, g) => a + g.count, 0);
    expect(total).toBe(1412);
    expect(count).toBe(8); // one per ledger row
    const stateSales = groups.find(
      (g) => g.key.jurisdictionType === 'state' && g.key.taxType === 'sales',
    );
    expect(stateSales?.amountCents).toBe(270); // A:150 + B:120
  });
});
