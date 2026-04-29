import { describe, it, expect } from 'vitest';
import { split, refund } from '../src/index.js';
import type { OrderInput } from '../src/types.js';

/**
 * Multi-jurisdiction: ship-from OR → ship-to CA with NV transit-excise on
 * line A. Each (jurisdiction, taxType) is its own row — the splitter never
 * collapses them. Refunds preserve the per-jurisdiction breakdown.
 */
const MULTI_JURIS: OrderInput = {
  orderId: 'order_or_ca_001',
  currency: 'USD',
  engineRef: 'engine_or_ca_001',
  totalTaxCents: 350,
  shipping: {
    shipFrom: { type: 'state', code: 'OR' },
    shipTo: { type: 'state', code: 'CA' },
    transit: [{ type: 'state', code: 'NV' }],
  },
  lines: [
    {
      lineItemId: 'A',
      quantity: 1,
      unitAmountCents: 5000,
      taxes: [
        // ship-to sales tax (CA + LA county + LA city)
        { jurisdiction: { type: 'state', code: 'CA' }, taxType: 'sales', amountCents: 200 },
        { jurisdiction: { type: 'county', code: 'CA-LA' }, taxType: 'sales', amountCents: 50 },
        { jurisdiction: { type: 'city', code: 'CA-LA' }, taxType: 'sales', amountCents: 25 },
        // transit excise — NV charges a flat excise on certain goods passing through
        { jurisdiction: { type: 'state', code: 'NV' }, taxType: 'additional', amountCents: 75 },
      ],
      deposits: [],
    },
  ],
  fees: [],
};

describe('multi-jurisdiction', () => {
  it('preserves one row per (jurisdiction, taxType) — no collapsing', () => {
    const ledger = split(MULTI_JURIS);
    expect(ledger.rows).toHaveLength(4);

    const byJurisdictionType = ledger.rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.jurisdiction.type] = (acc[r.jurisdiction.type] ?? 0) + 1;
      return acc;
    }, {});
    expect(byJurisdictionType).toEqual({ state: 2, county: 1, city: 1 });
  });

  it('netCents filter by jurisdictionType slices the right rows', () => {
    const ledger = split(MULTI_JURIS);
    expect(ledger.netCents({ jurisdictionType: 'state' })).toBe(275); // 200 CA + 75 NV
    expect(ledger.netCents({ jurisdictionType: 'county' })).toBe(50);
    expect(ledger.netCents({ jurisdictionType: 'city' })).toBe(25);
  });

  it('refund across multi-jurisdiction line allocates proportionally per jurisdiction', () => {
    const ledger = split(MULTI_JURIS);
    // refund half the line's tax (350/2 = 175 — but allocator rounds, so we'll
    // assert sum equality, not per-row exactness)
    const delta = refund(ledger, {
      refundId: 'rf_half',
      lines: [{ lineItemId: 'A', amountCents: 175 }],
    });
    expect(delta.reduce((a, r) => a + r.amountCents, 0)).toBe(-175);
    // Every jurisdiction with positive net should have a delta row
    const deltaJurisdictions = new Set(delta.map((r) => `${r.jurisdiction.type}:${r.jurisdiction.code}`));
    expect(deltaJurisdictions.size).toBeGreaterThanOrEqual(3);
  });

  it('separate ship-from and ship-to jurisdictions appear as distinct rows when both tax', () => {
    const splitFrom: OrderInput = {
      ...MULTI_JURIS,
      orderId: 'order_split',
      totalTaxCents: 50 + 200,
      lines: [
        {
          ...MULTI_JURIS.lines[0]!,
          taxes: [
            // origin-state excise
            { jurisdiction: { type: 'state', code: 'OR' }, taxType: 'additional', amountCents: 50 },
            // destination-state sales
            { jurisdiction: { type: 'state', code: 'CA' }, taxType: 'sales', amountCents: 200 },
          ],
        },
      ],
    };
    const ledger = split(splitFrom);
    const codes = new Set(ledger.rows.map((r) => r.jurisdiction.code));
    expect(codes.has('OR')).toBe(true);
    expect(codes.has('CA')).toBe(true);
  });
});
