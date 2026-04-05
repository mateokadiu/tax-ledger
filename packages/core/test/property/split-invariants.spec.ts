import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { split } from '../../src/index.js';
import { orderInputArb } from './arbitraries.js';

describe('property: split() invariants', () => {
  it('tax-row sum equals input.totalTaxCents for any valid order (1000 runs)', () => {
    fc.assert(
      fc.property(orderInputArb, (input) => {
        const ledger = split(input);
        const taxSum =
          ledger.netCents({ taxType: 'sales' })
          + ledger.netCents({ taxType: 'shipping' })
          + ledger.netCents({ taxType: 'additional' });
        return taxSum === input.totalTaxCents;
      }),
      { numRuns: 1000 },
    );
  });

  it('deposit-row sum equals input deposit sum (1000 runs)', () => {
    fc.assert(
      fc.property(orderInputArb, (input) => {
        const ledger = split(input);
        const depositSum = input.lines.flatMap((l) => l.deposits ?? []).reduce((a, d) => a + d.amountCents, 0);
        return ledger.netCents({ taxType: 'bottle_deposit' }) === depositSum;
      }),
      { numRuns: 1000 },
    );
  });

  it('every emitted amountCents is an integer (1000 runs)', () => {
    fc.assert(
      fc.property(orderInputArb, (input) => {
        const ledger = split(input);
        return ledger.rows.every((r) => Number.isInteger(r.amountCents));
      }),
      { numRuns: 1000 },
    );
  });

  it('every ledger row carries the order id and currency (1000 runs)', () => {
    fc.assert(
      fc.property(orderInputArb, (input) => {
        const ledger = split(input);
        return ledger.rows.every((r) => r.orderId === input.orderId && r.currency === input.currency);
      }),
      { numRuns: 1000 },
    );
  });

  it('all row ids are unique (1000 runs)', () => {
    fc.assert(
      fc.property(orderInputArb, (input) => {
        const ledger = split(input);
        const ids = ledger.rows.map((r) => r.id);
        return new Set(ids).size === ids.length;
      }),
      { numRuns: 1000 },
    );
  });
});
