import { describe, it, expect } from 'vitest';
import { split, refund, OverRefundError } from '../src/index.js';
import { NY_THREE_LINE } from './fixtures.js';

describe('refund()', () => {
  it('refunding a whole line emits delta rows that sum to -lineNet', () => {
    const ledger = split(NY_THREE_LINE);
    const lineA_net = ledger.netCents({ lineItemId: 'A' }); // 150 + 45 + 36 + 1000 = 1231
    expect(lineA_net).toBe(1231);

    const delta = refund(ledger, {
      refundId: 'rf_full_A',
      lines: [{ lineItemId: 'A', amountCents: lineA_net }],
    });

    const deltaSum = delta.reduce((a, r) => a + r.amountCents, 0);
    expect(deltaSum).toBe(-lineA_net);
    // 4 rows refunded (3 sales + 1 deposit)
    expect(delta).toHaveLength(4);
    expect(delta.every((r) => r.amountCents < 0)).toBe(true);
    expect(delta.every((r) => r.origin.kind === 'refund')).toBe(true);
  });

  it('partial refund by amountCents allocates with largest-remainder', () => {
    const ledger = split(NY_THREE_LINE);
    // Line A net = 1231. Refund half = 615.5 → 616 (banker's round in the
    // per-amount compute, then largest-remainder across rows).
    const delta = refund(ledger, {
      refundId: 'rf_half_A',
      lines: [{ lineItemId: 'A', amountCents: 616 }],
    });
    const sum = delta.reduce((a, r) => a + r.amountCents, 0);
    expect(sum).toBe(-616);
    expect(delta.every((r) => Number.isInteger(r.amountCents))).toBe(true);
  });

  it('refunding a fee emits negative deltas for that fee scope only', () => {
    const ledger = split(NY_THREE_LINE);
    const shippingNet = ledger.netCents({ feeKind: 'shipping' });
    expect(shippingNet).toBe(3);

    const delta = refund(ledger, {
      refundId: 'rf_shipping',
      fees: [{ feeKind: 'shipping' }], // omitted amountCents → full refund
    });
    expect(delta.reduce((a, r) => a + r.amountCents, 0)).toBe(-3);
    expect(delta.every((r) => r.scope.kind === 'fee')).toBe(true);
  });

  it('over-refund throws OverRefundError', () => {
    const ledger = split(NY_THREE_LINE);
    expect(() =>
      refund(ledger, {
        refundId: 'rf_over',
        lines: [{ lineItemId: 'A', amountCents: 999_999 }],
      }),
    ).toThrow(OverRefundError);
  });

  it('refunding a non-existent line is a no-op (no rows to refund)', () => {
    const ledger = split(NY_THREE_LINE);
    const delta = refund(ledger, {
      refundId: 'rf_missing',
      lines: [{ lineItemId: 'NOPE', amountCents: 100 }],
    });
    expect(delta).toHaveLength(0);
  });

  it('chained refunds reconcile against the live ledger', () => {
    const ledger = split(NY_THREE_LINE);
    // Refund half of A, then the other half. After both: A's net = 0.
    const half1 = refund(ledger, {
      refundId: 'rf_1',
      lines: [{ lineItemId: 'A', amountCents: 600 }],
    });
    const afterFirst = ledger.with(half1);
    const remainingA = afterFirst.netCents({ lineItemId: 'A' });
    expect(remainingA).toBe(1231 - 600);

    const half2 = refund(afterFirst, {
      refundId: 'rf_2',
      lines: [{ lineItemId: 'A', amountCents: remainingA }],
    });
    const final = afterFirst.with(half2);
    expect(final.netCents({ lineItemId: 'A' })).toBe(0);
  });
});
