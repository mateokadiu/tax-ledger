import { describe, it, expect } from 'vitest';
import { toStripeReversal, reversalTotals } from '../src/index.js';

describe('toStripeReversal()', () => {
  it('builds a full reversal', () => {
    expect(
      toStripeReversal({ mode: 'full', originalTransaction: 'tax_txn_1', reference: 'cancel-42' }),
    ).toEqual({ mode: 'full', original_transaction: 'tax_txn_1', reference: 'cancel-42' });
  });

  it('builds a flat partial reversal with a negative amount', () => {
    expect(
      toStripeReversal({
        mode: 'partial',
        originalTransaction: 'tax_txn_1',
        reference: 'refund-7',
        flatAmountCents: 1500, // positive in → negated out
      }),
    ).toEqual({
      mode: 'partial',
      original_transaction: 'tax_txn_1',
      reference: 'refund-7',
      flat_amount: -1500,
    });
  });

  it('builds a per-line partial reversal with negative amount + amount_tax', () => {
    const params = toStripeReversal({
      mode: 'partial',
      originalTransaction: 'tax_txn_1',
      reference: 'refund-8',
      lineItems: [
        { originalLineItem: 'tax_li_1', amountCents: 1499, amountTaxCents: 148, reference: 'pizza' },
      ],
    });
    expect(params.line_items).toEqual([
      { amount: -1499, amount_tax: -148, original_line_item: 'tax_li_1', reference: 'pizza' },
    ]);
  });
});

describe('reversalTotals()', () => {
  it('sums reversed line items + shipping (wrapped list form)', () => {
    const totals = reversalTotals({
      object: 'tax.transaction',
      mode: 'reversal',
      line_items: {
        data: [
          { amount: -1499, amount_tax: -148 },
          { amount: -500, amount_tax: -41 },
        ],
      },
      shipping_cost: { amount: -200, amount_tax: -16 },
    });
    expect(totals).toEqual({ netCents: -2199, taxCents: -205, totalCents: -2404 });
  });

  it('accepts the bare-array line_items form and a null shipping_cost', () => {
    const totals = reversalTotals({
      line_items: [{ amount: -1000, amount_tax: -90 }],
      shipping_cost: null,
    });
    expect(totals.taxCents).toBe(-90);
    expect(totals.totalCents).toBe(-1090);
  });
});
