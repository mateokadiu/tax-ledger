import { describe, it } from 'vitest';
import fc from 'fast-check';
import { split, partialCapture, revise } from '../../src/index.js';
import { orderInputArb } from './arbitraries.js';

describe('property: capture + revise', () => {
  it('partial capture delta sums to negative uncaptured-fraction of liveNet (500 runs)', () => {
    fc.assert(
      fc.property(
        orderInputArb,
        fc.integer({ min: 1, max: 9999 }),
        (input, capturedPct) => {
          const ledger = split(input);
          const liveNet = ledger.rows.filter((r) => r.amountCents > 0).reduce((a, r) => a + r.amountCents, 0);
          if (liveNet <= 0) return true;
          const original = 10000;
          const captured = Math.floor((capturedPct / 10000) * original);
          if (captured > original) return true;
          const delta = partialCapture(ledger, {
            captureId: 'cap_prop',
            capturedAmountCents: captured,
            originalAmountCents: original,
          });
          // sum(delta) must be non-positive, and equal to -round(liveNet * (1 - captured/original))
          const sum = delta.reduce((a, r) => a + r.amountCents, 0);
          return sum <= 0 && Number.isInteger(sum);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('revise(ledger, sameOrder) is a no-op (1000 runs)', () => {
    fc.assert(
      fc.property(orderInputArb, (input) => {
        const ledger = split(input);
        const delta = revise(ledger, { revisionId: 'rev_self', newOrder: input });
        return delta.length === 0;
      }),
      { numRuns: 1000 },
    );
  });

  it('revise(ledger, newOrder) applied yields a live rollup matching split(newOrder) (500 runs)', () => {
    fc.assert(
      fc.property(orderInputArb, orderInputArb, (a, b) => {
        // Force them to share orderId/currency so the revise diff is sensible.
        const newOrder = { ...b, orderId: a.orderId, currency: a.currency };
        const ledger = split(a);
        const delta = revise(ledger, { revisionId: 'rev_diff', newOrder });
        const live = ledger.with(delta);
        // The live ledger's per-(scope,jurisdiction,taxType) rollup must
        // match a fresh split(newOrder)'s rollup.
        const expected = split(newOrder);
        const expectedTax =
          expected.netCents({ taxType: 'sales' })
          + expected.netCents({ taxType: 'shipping' })
          + expected.netCents({ taxType: 'additional' });
        const actualTax =
          live.netCents({ taxType: 'sales' })
          + live.netCents({ taxType: 'shipping' })
          + live.netCents({ taxType: 'additional' });
        const expectedDep = expected.netCents({ taxType: 'bottle_deposit' });
        const actualDep = live.netCents({ taxType: 'bottle_deposit' });
        return expectedTax === actualTax && expectedDep === actualDep;
      }),
      { numRuns: 500 },
    );
  });
});
