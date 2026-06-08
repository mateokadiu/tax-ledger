import { describe, it, expect } from 'vitest';
import {
  split,
  refund,
  reconcile,
  TaxLedgerInvariantError,
  CurrencyMismatchError,
} from '../src/index.js';
import { NY_THREE_LINE } from './fixtures.js';

describe('reconcile()', () => {
  it('folds an engine delta into the ledger and verifies the reported total', () => {
    const ledger = split(NY_THREE_LINE);
    const delta = refund(ledger, { refundId: 'rf_b', lines: [{ lineItemId: 'B', amountCents: 178 }] });
    const next = reconcile(ledger, delta, { expectTotalCents: -178 });
    expect(next.rows).toHaveLength(ledger.rows.length + delta.length);
    expect(next.netCents({ lineItemId: 'B' })).toBe(0);
  });

  it('throws when the delta disagrees with the engine-reported total', () => {
    const ledger = split(NY_THREE_LINE);
    const delta = refund(ledger, { refundId: 'rf_b', lines: [{ lineItemId: 'B', amountCents: 178 }] });
    expect(() => reconcile(ledger, delta, { expectTotalCents: -200 })).toThrow(TaxLedgerInvariantError);
    // ...but tolerates drift inside the band
    expect(() => reconcile(ledger, delta, { expectTotalCents: -200, toleranceCents: 25 })).not.toThrow();
  });

  it('refuses a cross-currency delta', () => {
    const ledger = split(NY_THREE_LINE);
    const foreign = refund(ledger, {
      refundId: 'rf_b',
      lines: [{ lineItemId: 'B', amountCents: 178 }],
    }).map((r) => ({ ...r, currency: 'EUR' }));
    expect(() => reconcile(ledger, foreign)).toThrow(CurrencyMismatchError);
  });

  it('with no expected total, just appends (currency-checked)', () => {
    const ledger = split(NY_THREE_LINE);
    const delta = refund(ledger, { refundId: 'rf_a', lines: [{ lineItemId: 'A', quantity: 1 }] });
    const next = reconcile(ledger, delta);
    expect(next.rows.length).toBe(ledger.rows.length + delta.length);
  });
});
