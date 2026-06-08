import { describe, it, expect } from 'vitest';
import { split, refund, type LedgerOptions, type TaxInput } from '../src/index.js';
import { NY_THREE_LINE } from './fixtures.js';

describe('determinism', () => {
  it('injected clock + id generator make split byte-for-byte reproducible', () => {
    const makeOpts = (): LedgerOptions => {
      let n = 0;
      return {
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        generateId: () => `id_${n++}`,
      };
    };
    const a = split(NY_THREE_LINE, makeOpts());
    const b = split(NY_THREE_LINE, makeOpts());
    expect(a.rows).toEqual(b.rows);
    expect(a.rows[0]!.id).toBe('id_0');
    expect(a.rows[0]!.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  // Two equal-weight buckets + an odd refund forces a remainder tie. With random
  // row ids the residual cent could land on either bucket run-to-run; the
  // allocator must instead break the tie on stable row position.
  const TIE: TaxInput = {
    orderId: 'tie',
    currency: 'USD',
    engineRef: 'e',
    totalTaxCents: 100,
    lines: [
      {
        lineItemId: 'X',
        quantity: 1,
        unitAmountCents: 1000,
        taxes: [
          { jurisdiction: { type: 'state', code: 'S' }, taxType: 'sales', amountCents: 50 },
          { jurisdiction: { type: 'county', code: 'C' }, taxType: 'sales', amountCents: 50 },
        ],
      },
    ],
  };

  it('breaks remainder ties deterministically across independent splits', () => {
    const run = (): string[] => {
      const ledger = split(TIE); // default RANDOM uuids each run
      const delta = refund(ledger, { refundId: 'rf', lines: [{ lineItemId: 'X', amountCents: 51 }] });
      return delta.map((d) => `${d.jurisdiction.code}=${d.amountCents}`).sort();
    };
    expect(run()).toEqual(run());

    const ledger = split(TIE);
    const delta = refund(ledger, { refundId: 'rf', lines: [{ lineItemId: 'X', amountCents: 51 }] });
    const state = delta.find((d) => d.jurisdiction.code === 'S')!;
    const county = delta.find((d) => d.jurisdiction.code === 'C')!;
    // residual lands on the first (state) bucket, every time
    expect(state.amountCents).toBe(-26);
    expect(county.amountCents).toBe(-25);
  });
});
