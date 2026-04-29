import { describe, it } from 'vitest';
import fc from 'fast-check';
import { split, refund } from '../../src/index.js';
import { orderInputArb } from './arbitraries.js';

/**
 * Property: when a line has taxes across multiple (jurisdiction, taxType)
 * tuples, refunding the entire line must produce one delta row per positive
 * source row, summing to -lineNet, with every jurisdiction represented.
 */
describe('property: multi-jurisdiction', () => {
  it('refunding the full line produces one delta per positive source row (500 runs)', () => {
    fc.assert(
      fc.property(orderInputArb, (input) => {
        const ledger = split(input);
        const target = input.lines.find((l) => {
          const rows = ledger.rowsForLine(l.lineItemId);
          const positiveRowCount = rows.filter((r) => r.amountCents > 0).length;
          return positiveRowCount >= 2; // need at least 2 to make this interesting
        });
        if (!target) return true;
        const lineNet = ledger.netCents({ lineItemId: target.lineItemId });
        if (lineNet <= 0) return true;
        const delta = refund(ledger, {
          refundId: 'rf_multi',
          lines: [{ lineItemId: target.lineItemId, amountCents: lineNet }],
        });
        const positiveRows = ledger.rowsForLine(target.lineItemId).filter((r) => r.amountCents > 0);
        // every positive source row must have a corresponding delta row
        return delta.length === positiveRows.length
          && delta.reduce((a, r) => a + r.amountCents, 0) === -lineNet;
      }),
      { numRuns: 500 },
    );
  });

  it('each delta row inherits jurisdiction + taxType from its source row (500 runs)', () => {
    fc.assert(
      fc.property(orderInputArb, (input) => {
        const ledger = split(input);
        const target = input.lines.find((l) => {
          const rows = ledger.rowsForLine(l.lineItemId);
          return rows.some((r) => r.amountCents > 0);
        });
        if (!target) return true;
        const lineNet = ledger.netCents({ lineItemId: target.lineItemId });
        if (lineNet <= 0) return true;
        const delta = refund(ledger, {
          refundId: 'rf_inherit',
          lines: [{ lineItemId: target.lineItemId, amountCents: lineNet }],
        });
        const sourceKeys = new Set(
          ledger
            .rowsForLine(target.lineItemId)
            .filter((r) => r.amountCents > 0)
            .map((r) => `${r.jurisdiction.type}:${r.jurisdiction.code}:${r.taxType}`),
        );
        const deltaKeys = new Set(
          delta.map((r) => `${r.jurisdiction.type}:${r.jurisdiction.code}:${r.taxType}`),
        );
        return [...deltaKeys].every((k) => sourceKeys.has(k));
      }),
      { numRuns: 500 },
    );
  });
});
