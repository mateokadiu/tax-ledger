import { describe, it, expect } from 'vitest';
import { split, partialCapture } from '../src/index.js';
import { TaxLedgerInvariantError } from '../src/errors.js';
import { NY_THREE_LINE } from './fixtures.js';

describe('partialCapture()', () => {
  it('no delta when captured == original', () => {
    const ledger = split(NY_THREE_LINE);
    const delta = partialCapture(ledger, {
      captureId: 'cap_full',
      capturedAmountCents: 10000,
      originalAmountCents: 10000,
    });
    expect(delta).toHaveLength(0);
  });

  it('half capture removes half the live tax (allocated by largest-remainder)', () => {
    const ledger = split(NY_THREE_LINE);
    // NY_THREE_LINE liveNet (positive rows only) = 412 + 1000 = 1412.
    // Half capture: uncaptured fraction = 0.5 → uncaptured = 706
    const delta = partialCapture(ledger, {
      captureId: 'cap_half',
      capturedAmountCents: 5000,
      originalAmountCents: 10000,
    });
    const sum = delta.reduce((a, r) => a + r.amountCents, 0);
    expect(sum).toBe(-706);
    expect(delta.every((r) => r.amountCents < 0)).toBe(true);
    expect(delta.every((r) => r.origin.kind === 'capture')).toBe(true);
  });

  it('quarter capture leaves quarter of the tax in live ledger', () => {
    const ledger = split(NY_THREE_LINE);
    // capture 25% → uncaptured = 75% of 1412 = 1059
    const delta = partialCapture(ledger, {
      captureId: 'cap_quarter',
      capturedAmountCents: 2500,
      originalAmountCents: 10000,
    });
    expect(delta.reduce((a, r) => a + r.amountCents, 0)).toBe(-1059);
    const live = ledger.with(delta);
    const liveTax =
      live.netCents({ taxType: 'sales' })
      + live.netCents({ taxType: 'shipping' })
      + live.netCents({ taxType: 'additional' })
      + live.netCents({ taxType: 'bottle_deposit' });
    expect(liveTax).toBe(1412 - 1059); // 353 ≈ 25% of 1412
  });

  it('throws when captured > original', () => {
    const ledger = split(NY_THREE_LINE);
    expect(() =>
      partialCapture(ledger, {
        captureId: 'cap_over',
        capturedAmountCents: 11000,
        originalAmountCents: 10000,
      }),
    ).toThrow(TaxLedgerInvariantError);
  });

  it('integer-cent output for any capture ratio', () => {
    const ledger = split(NY_THREE_LINE);
    for (const captured of [1, 100, 1234, 5678, 9876]) {
      const delta = partialCapture(ledger, {
        captureId: `cap_${captured}`,
        capturedAmountCents: captured,
        originalAmountCents: 10000,
      });
      expect(delta.every((r) => Number.isInteger(r.amountCents))).toBe(true);
    }
  });
});
