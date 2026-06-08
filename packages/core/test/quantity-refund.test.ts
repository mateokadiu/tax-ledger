import { describe, it, expect } from 'vitest';
import { split, refund, OverRefundError } from '../src/index.js';
import { NY_THREE_LINE } from './fixtures.js';

describe('quantity-based refunds', () => {
  it('split stamps the line quantity onto line rows', () => {
    const ledger = split(NY_THREE_LINE);
    expect(ledger.rowsForLine('A').every((r) => r.quantity === 2)).toBe(true);
    expect(ledger.rowsForLine('B').every((r) => r.quantity === 1)).toBe(true);
    // fee rows carry no quantity
    expect(ledger.rowsForFee('shipping').every((r) => r.quantity == null)).toBe(true);
  });

  it('refunding 1 of 2 units removes a proportional half of the line net', () => {
    const ledger = split(NY_THREE_LINE);
    // Line A net = 1231 over qty 2 → one unit ≈ 615.5 → 616 (banker's round).
    const delta = refund(ledger, {
      refundId: 'rf_qty1_A',
      lines: [{ lineItemId: 'A', quantity: 1 }],
    });
    expect(delta.reduce((a, r) => a + r.amountCents, 0)).toBe(-616);
    expect(delta.every((r) => Number.isInteger(r.amountCents))).toBe(true);
  });

  it('refunding the full quantity removes the whole line', () => {
    const ledger = split(NY_THREE_LINE);
    const delta = refund(ledger, {
      refundId: 'rf_qty2_A',
      lines: [{ lineItemId: 'A', quantity: 2 }],
    });
    expect(delta.reduce((a, r) => a + r.amountCents, 0)).toBe(-1231);
  });

  it('refunding more units than remain throws OverRefundError', () => {
    const ledger = split(NY_THREE_LINE);
    expect(() =>
      refund(ledger, { refundId: 'rf_qty3_A', lines: [{ lineItemId: 'A', quantity: 3 }] }),
    ).toThrow(OverRefundError);
  });

  it('chained quantity refunds zero the line exactly (no penny drift)', () => {
    const ledger = split(NY_THREE_LINE);
    const d1 = refund(ledger, { refundId: 'rf_a', lines: [{ lineItemId: 'A', quantity: 1 }] });
    const afterFirst = ledger.with(d1);
    const d2 = refund(afterFirst, { refundId: 'rf_b', lines: [{ lineItemId: 'A', quantity: 1 }] });
    const final = afterFirst.with(d2);
    expect(final.netCents({ lineItemId: 'A' })).toBe(0);
    // total refunded across both == original line net
    const totalRefunded = [...d1, ...d2].reduce((a, r) => a + r.amountCents, 0);
    expect(totalRefunded).toBe(-1231);
  });

  it('quantity refund of a single-unit line refunds it fully', () => {
    const ledger = split(NY_THREE_LINE);
    const delta = refund(ledger, { refundId: 'rf_b', lines: [{ lineItemId: 'B', quantity: 1 }] });
    expect(delta.reduce((a, r) => a + r.amountCents, 0)).toBe(-178);
  });
});
