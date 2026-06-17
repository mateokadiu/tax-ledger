import { describe, it, expect } from 'vitest';
import {
  split,
  refund,
  revise,
  CurrencyMismatchError,
  type TaxInput,
} from '../src/index.js';
import { NY_THREE_LINE } from './fixtures.js';

describe('multi-currency', () => {
  it('rejects an OrderInput with a lowercase currency code', () => {
    const bad: TaxInput = { ...NY_THREE_LINE, currency: 'usd' };
    expect(() => split(bad)).toThrow(/ISO-4217/);
  });

  it('rejects an OrderInput with a four-letter currency code', () => {
    const bad: TaxInput = { ...NY_THREE_LINE, currency: 'USDX' };
    expect(() => split(bad)).toThrow();
  });

  it('accepts an exotic but well-formed ISO-4217 code', () => {
    const eur: TaxInput = { ...NY_THREE_LINE, currency: 'EUR' };
    const ledger = split(eur);
    expect(ledger.currency).toBe('EUR');
    expect(ledger.rows.every((r) => r.currency === 'EUR')).toBe(true);
  });

  it('Ledger.with refuses a delta entry from a different currency', () => {
    const ledger = split(NY_THREE_LINE);
    const delta = refund(ledger, {
      refundId: 'rf_curr',
      lines: [{ lineItemId: 'A', amountCents: 100 }],
    });
    const polluted = delta.map((r, i) =>
      i === 0 ? { ...r, currency: 'EUR' as const } : r,
    );
    expect(() => ledger.with(polluted)).toThrow(CurrencyMismatchError);
  });

  it('revise refuses a newOrder with a different currency', () => {
    const ledger = split(NY_THREE_LINE);
    const newOrder: TaxInput = { ...NY_THREE_LINE, currency: 'EUR' };
    expect(() =>
      revise(ledger, { revisionId: 'rv_curr', newOrder }),
    ).toThrow(CurrencyMismatchError);
  });

  it('CurrencyMismatchError carries expected + actual codes', () => {
    const ledger = split(NY_THREE_LINE);
    const newOrder: TaxInput = { ...NY_THREE_LINE, currency: 'GBP' };
    try {
      revise(ledger, { revisionId: 'rv_curr2', newOrder });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CurrencyMismatchError);
      const err = e as CurrencyMismatchError;
      expect(err.details.expected).toBe('USD');
      expect(err.details.actual).toBe('GBP');
    }
  });
});
