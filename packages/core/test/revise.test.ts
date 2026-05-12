import { describe, it, expect } from 'vitest';
import { split, revise } from '../src/index.js';
import type { OrderInput } from '../src/types.js';
import { NY_THREE_LINE } from './fixtures.js';

describe('revise()', () => {
  it('no delta when revised order matches prior', () => {
    const ledger = split(NY_THREE_LINE);
    const delta = revise(ledger, {
      revisionId: 'rev_noop',
      newOrder: NY_THREE_LINE,
    });
    expect(delta).toHaveLength(0);
  });

  it('removing a line emits negative deltas equal to the line net', () => {
    const ledger = split(NY_THREE_LINE);
    const withoutB: OrderInput = {
      ...NY_THREE_LINE,
      totalTaxCents: 412 - (120 + 36 + 22),
      lines: NY_THREE_LINE.lines.filter((l) => l.lineItemId !== 'B'),
    };
    const delta = revise(ledger, {
      revisionId: 'rev_drop_B',
      newOrder: withoutB,
    });
    const lineBNet = ledger.netCents({ lineItemId: 'B' });
    expect(lineBNet).toBe(178);
    // delta should net to -lineBNet across line B rows
    const lineBDelta = delta.filter((r) => r.scope.kind === 'line' && r.scope.lineItemId === 'B');
    expect(lineBDelta.reduce((a, r) => a + r.amountCents, 0)).toBe(-178);
    expect(lineBDelta.every((r) => r.amountCents < 0)).toBe(true);
  });

  it('adding a line emits positive deltas equal to the new line', () => {
    const ledger = split(NY_THREE_LINE);
    const withC: OrderInput = {
      ...NY_THREE_LINE,
      totalTaxCents: 412 + 50,
      lines: [
        ...NY_THREE_LINE.lines,
        {
          lineItemId: 'C',
          quantity: 1,
          unitAmountCents: 1000,
          taxes: [{ jurisdiction: { type: 'state', code: 'NY' }, taxType: 'sales', amountCents: 50 }],
          deposits: [],
        },
      ],
    };
    const delta = revise(ledger, {
      revisionId: 'rev_add_C',
      newOrder: withC,
    });
    const lineCDelta = delta.filter((r) => r.scope.kind === 'line' && r.scope.lineItemId === 'C');
    expect(lineCDelta.reduce((a, r) => a + r.amountCents, 0)).toBe(50);
    expect(lineCDelta.every((r) => r.amountCents > 0)).toBe(true);
  });

  it('changing a tax amount emits a delta for the affected (line, jurisdiction, taxType)', () => {
    const ledger = split(NY_THREE_LINE);
    // bump line A state tax from 150 to 200, total +50
    const revised: OrderInput = {
      ...NY_THREE_LINE,
      totalTaxCents: 412 + 50,
      lines: NY_THREE_LINE.lines.map((l) =>
        l.lineItemId === 'A'
          ? {
              ...l,
              taxes: l.taxes.map((t) =>
                t.jurisdiction.code === 'NY' && t.jurisdiction.type === 'state'
                  ? { ...t, amountCents: 200 }
                  : t,
              ),
            }
          : l,
      ),
    };
    const delta = revise(ledger, {
      revisionId: 'rev_bump',
      newOrder: revised,
    });
    expect(delta).toHaveLength(1);
    expect(delta[0]!.amountCents).toBe(50);
    expect(delta[0]!.jurisdiction.code).toBe('NY');
    expect(delta[0]!.taxType).toBe('sales');
  });

  it('applying revise delta makes the live rollup match the new order', () => {
    const ledger = split(NY_THREE_LINE);
    const revised: OrderInput = {
      ...NY_THREE_LINE,
      totalTaxCents: 412 + 50,
      lines: NY_THREE_LINE.lines.map((l) =>
        l.lineItemId === 'A'
          ? {
              ...l,
              taxes: l.taxes.map((t) =>
                t.jurisdiction.code === 'NY' && t.jurisdiction.type === 'state'
                  ? { ...t, amountCents: 200 }
                  : t,
              ),
            }
          : l,
      ),
    };
    const delta = revise(ledger, {
      revisionId: 'rev_apply',
      newOrder: revised,
    });
    const live = ledger.with(delta);
    // live tax total = new totalTaxCents
    const liveTax =
      live.netCents({ taxType: 'sales' })
      + live.netCents({ taxType: 'shipping' })
      + live.netCents({ taxType: 'additional' });
    expect(liveTax).toBe(revised.totalTaxCents);
  });
});
