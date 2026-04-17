import { describe, it } from 'vitest';
import fc from 'fast-check';
import { split, refund } from '../../src/index.js';
import { orderInputArb } from './arbitraries.js';

describe('property: refund() invariants', () => {
  it('refund deltas sum to -refundAmount for any line refund (1000 runs)', () => {
    fc.assert(
      fc.property(orderInputArb, (input) => {
        const ledger = split(input);
        // Find first line with positive net
        const lineWithNet = input.lines.find((l) => {
          const rows = ledger.rowsForLine(l.lineItemId);
          return rows.reduce((a, r) => a + r.amountCents, 0) > 0;
        });
        if (!lineWithNet) return true;
        const lineNet = ledger.netCents({ lineItemId: lineWithNet.lineItemId });
        // refund a deterministic-but-random fraction (half, rounded down)
        const refundAmt = Math.floor(lineNet / 2);
        if (refundAmt <= 0) return true;
        const delta = refund(ledger, {
          refundId: `rf_${input.orderId}`,
          lines: [{ lineItemId: lineWithNet.lineItemId, amountCents: refundAmt }],
        });
        const sum = delta.reduce((a, r) => a + r.amountCents, 0);
        return sum === -refundAmt;
      }),
      { numRuns: 1000 },
    );
  });

  it('refund deltas are all integer cents (1000 runs)', () => {
    fc.assert(
      fc.property(orderInputArb, (input) => {
        const ledger = split(input);
        const lineWithNet = input.lines.find((l) => {
          const rows = ledger.rowsForLine(l.lineItemId);
          return rows.reduce((a, r) => a + r.amountCents, 0) > 0;
        });
        if (!lineWithNet) return true;
        const lineNet = ledger.netCents({ lineItemId: lineWithNet.lineItemId });
        if (lineNet <= 0) return true;
        const delta = refund(ledger, {
          refundId: 'rf_int',
          lines: [{ lineItemId: lineWithNet.lineItemId, amountCents: lineNet }],
        });
        return delta.every((r) => Number.isInteger(r.amountCents));
      }),
      { numRuns: 1000 },
    );
  });

  it('full-line refund zeroes the line in the live ledger (500 runs)', () => {
    fc.assert(
      fc.property(orderInputArb, (input) => {
        const ledger = split(input);
        const lineWithNet = input.lines.find((l) => {
          const rows = ledger.rowsForLine(l.lineItemId);
          return rows.reduce((a, r) => a + r.amountCents, 0) > 0;
        });
        if (!lineWithNet) return true;
        const lineNet = ledger.netCents({ lineItemId: lineWithNet.lineItemId });
        const delta = refund(ledger, {
          refundId: 'rf_zero',
          lines: [{ lineItemId: lineWithNet.lineItemId, amountCents: lineNet }],
        });
        const live = ledger.with(delta);
        return live.netCents({ lineItemId: lineWithNet.lineItemId }) === 0;
      }),
      { numRuns: 500 },
    );
  });

  it('refund replay is idempotent on the same delta — sum unchanged (500 runs)', () => {
    fc.assert(
      fc.property(orderInputArb, (input) => {
        const ledger = split(input);
        const lineWithNet = input.lines.find((l) => {
          const rows = ledger.rowsForLine(l.lineItemId);
          return rows.reduce((a, r) => a + r.amountCents, 0) > 0;
        });
        if (!lineWithNet) return true;
        const lineNet = ledger.netCents({ lineItemId: lineWithNet.lineItemId });
        if (lineNet <= 0) return true;
        const amt = Math.max(1, Math.floor(lineNet / 3));
        const d1 = refund(ledger, {
          refundId: 'rf_r1',
          lines: [{ lineItemId: lineWithNet.lineItemId, amountCents: amt }],
        });
        const d2 = refund(ledger, {
          refundId: 'rf_r2',
          lines: [{ lineItemId: lineWithNet.lineItemId, amountCents: amt }],
        });
        const s1 = d1.reduce((a, r) => a + r.amountCents, 0);
        const s2 = d2.reduce((a, r) => a + r.amountCents, 0);
        return s1 === s2;
      }),
      { numRuns: 500 },
    );
  });
});
