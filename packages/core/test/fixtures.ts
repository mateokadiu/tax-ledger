import type { OrderInput } from '../src/types.js';

/**
 * Canonical NY 3-line order with a bottle deposit. Matches the worked example
 * in PLAN.md §2.
 *
 *   Line A: beer, qty 2 @ $24.99, with state/county/city sales tax + $5/unit deposit
 *   Line B: snack, qty 1 @ $19.99, state/county/city sales tax
 *   Line C: implicit shipping via fees
 *
 * Sums: line A taxes = 150+45+36 = $2.31. Line B = 120+36+22 = $1.78. Shipping = $0.03.
 * Total tax = $4.12. Deposit = $10.00.
 */
export const NY_THREE_LINE: OrderInput = {
  orderId: 'order_ny_001',
  currency: 'USD',
  engineRef: 'avalara_ny_001',
  totalTaxCents: 412,
  lines: [
    {
      lineItemId: 'A',
      quantity: 2,
      unitAmountCents: 2499,
      taxes: [
        { jurisdiction: { type: 'state', code: 'NY' }, taxType: 'sales', amountCents: 150 },
        { jurisdiction: { type: 'county', code: 'NY-NYC' }, taxType: 'sales', amountCents: 45 },
        { jurisdiction: { type: 'city', code: 'NY-NYC' }, taxType: 'sales', amountCents: 36 },
      ],
      deposits: [
        { jurisdiction: { type: 'state', code: 'NY' }, amountCents: 1000 },
      ],
    },
    {
      lineItemId: 'B',
      quantity: 1,
      unitAmountCents: 1999,
      taxes: [
        { jurisdiction: { type: 'state', code: 'NY' }, taxType: 'sales', amountCents: 120 },
        { jurisdiction: { type: 'county', code: 'NY-NYC' }, taxType: 'sales', amountCents: 36 },
        { jurisdiction: { type: 'city', code: 'NY-NYC' }, taxType: 'sales', amountCents: 22 },
      ],
      deposits: [],
    },
  ],
  fees: [
    {
      feeKind: 'shipping',
      amountCents: 652,
      taxes: [{ jurisdiction: { type: 'state', code: 'NY' }, taxType: 'shipping', amountCents: 3 }],
    },
  ],
};
