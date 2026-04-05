import fc from 'fast-check';
import type { OrderInput, LineItem, Fee, LineItemTax, LineItemDeposit, Jurisdiction } from '../../src/types.js';

/**
 * Property-test arbitraries. The hard constraint: every generated order must
 * be internally consistent — its lines' tax details must sum to its
 * totalTaxCents. The splitter's job is to faithfully reflect that sum and
 * deposit total, not to fix bad engine output.
 */

const codeArb = fc.string({ minLength: 1, maxLength: 6 }).filter((s) => /^[A-Za-z0-9-]+$/.test(s) && s.length > 0);

export const jurisdictionArb: fc.Arbitrary<Jurisdiction> = fc.record({
  type: fc.constantFrom('country', 'state', 'county', 'city', 'special'),
  code: codeArb,
});

function taxArb(maxCents: number): fc.Arbitrary<LineItemTax> {
  return fc.record({
    jurisdiction: jurisdictionArb,
    taxType: fc.constantFrom('sales', 'shipping', 'additional'),
    amountCents: fc.integer({ min: 0, max: maxCents }),
  });
}

function depositArb(maxCents: number): fc.Arbitrary<LineItemDeposit> {
  return fc.record({
    jurisdiction: fc.record({
      type: fc.constantFrom('country', 'state'),
      code: codeArb,
    }),
    amountCents: fc.integer({ min: 0, max: maxCents }),
  });
}

interface LineConfig {
  lineItemId: string;
  unitAmountCents: number;
  quantity: number;
  taxes: ReadonlyArray<LineItemTax>;
  deposits: ReadonlyArray<LineItemDeposit>;
}

const lineConfigArb = fc.tuple(
  fc.string({ minLength: 1, maxLength: 8 }).filter((s) => /^[A-Za-z0-9]+$/.test(s) && s.length > 0),
  fc.integer({ min: 1, max: 50_000 }),
  fc.integer({ min: 1, max: 10 }),
  fc.array(taxArb(500), { minLength: 0, maxLength: 4 }),
  fc.array(depositArb(2000), { minLength: 0, maxLength: 2 }),
).map(([id, unit, qty, taxes, deposits]): LineConfig => ({
  lineItemId: id,
  unitAmountCents: unit,
  quantity: qty,
  taxes,
  deposits,
}));

const feeArb: fc.Arbitrary<Fee> = fc
  .record({
    feeKind: fc.constantFrom('shipping', 'service', 'platform', 'tip', 'bag'),
    amountCents: fc.integer({ min: 0, max: 20_000 }),
    taxes: fc.array(taxArb(200), { minLength: 0, maxLength: 2 }),
  });

/**
 * Generate a valid OrderInput by:
 *   1. Drawing N lines.
 *   2. De-duplicating line ids (Zod doesn't enforce uniqueness, but our
 *      tests will inspect rowsForLine and need stable ids).
 *   3. Computing totalTaxCents from the actual tax details (so the
 *      invariant holds by construction).
 */
export const orderInputArb: fc.Arbitrary<OrderInput> = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 12 }).filter((s) => /^[A-Za-z0-9_-]+$/.test(s) && s.length > 0),
    fc.array(lineConfigArb, { minLength: 1, maxLength: 6 }),
    fc.array(feeArb, { minLength: 0, maxLength: 3 }),
  )
  .map(([orderId, rawLines, rawFees]) => {
    // dedupe line ids
    const seen = new Set<string>();
    const lines: LineItem[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      const raw = rawLines[i]!;
      let id = raw.lineItemId;
      while (seen.has(id)) id = `${id}_${i}`;
      seen.add(id);
      lines.push({
        lineItemId: id,
        quantity: raw.quantity,
        unitAmountCents: raw.unitAmountCents,
        taxes: [...raw.taxes],
        deposits: [...raw.deposits],
      });
    }
    const fees: Fee[] = rawFees;
    const taxSum =
      lines.flatMap((l) => l.taxes).reduce((a, t) => a + t.amountCents, 0)
      + fees.flatMap((f) => f.taxes).reduce((a, t) => a + t.amountCents, 0);
    return {
      orderId,
      currency: 'USD',
      engineRef: `engine_${orderId}`,
      totalTaxCents: taxSum,
      lines,
      fees,
    } satisfies OrderInput;
  });
