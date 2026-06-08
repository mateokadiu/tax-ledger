import {
  OrderInputSchema,
  type CurrencyCode,
  type LedgerEntry,
  type OrderInput,
  type OrderInputParsed,
  type LedgerOrigin,
  type LedgerScope,
  type TaxBehavior,
  type TaxType,
} from './types.js';
import { TaxLedgerInvariantError } from './errors.js';
import { sumCents } from './money.js';
import { Ledger } from './ledger.js';
import { resolveContext, type LedgerOptions } from './context.js';

const ROUNDING_TOLERANCE_CENTS = 1;

/**
 * Split an order's engine-computed taxes into a flat ledger.
 *
 * Emits one row per (lineItem, jurisdiction, taxType) plus one row per deposit
 * plus one row per (fee, jurisdiction, taxType). Bottle deposits get the
 * synthetic `taxType: 'bottle_deposit'`. Line rows carry the line's `quantity`
 * so quantity-based refunds can recover the original units later.
 *
 * Invariant: sum of emitted tax rows == input.totalTaxCents (deposits tracked
 * separately). If the engine's declared totalTaxCents disagrees by more than
 * 1 cent we throw — that's an upstream bug, not something to silently paper
 * over. 1-cent drift is absorbed as a `scope=order, reason=rounding_residual`
 * row.
 *
 * Pass `opts` ({ now, generateId }) to make the output deterministic/replayable.
 */
export function split(input: OrderInput, opts?: LedgerOptions): Ledger {
  const parsed: OrderInputParsed = OrderInputSchema.parse(input);
  const origin: LedgerOrigin = { kind: 'split', engineRef: parsed.engineRef };
  const { createdAt, nextId } = resolveContext(opts);

  const rows: LedgerEntry[] = [];

  for (const line of parsed.lines) {
    const scope: LedgerScope = { kind: 'line', lineItemId: line.lineItemId };
    for (const t of line.taxes) {
      rows.push(makeRow({
        id: nextId(),
        orderId: parsed.orderId, currency: parsed.currency,
        scope, jurisdiction: t.jurisdiction, taxType: t.taxType,
        amountCents: t.amountCents, origin, createdAt,
        taxCode: t.taxCode, taxBehavior: t.taxBehavior, engineTaxType: t.engineTaxType,
        quantity: line.quantity,
      }));
    }
    for (const d of line.deposits) {
      rows.push(makeRow({
        id: nextId(),
        orderId: parsed.orderId, currency: parsed.currency,
        scope, jurisdiction: d.jurisdiction, taxType: 'bottle_deposit',
        amountCents: d.amountCents, origin, createdAt,
        quantity: line.quantity,
      }));
    }
  }

  for (const fee of parsed.fees) {
    const scope: LedgerScope = { kind: 'fee', feeKind: fee.feeKind };
    for (const t of fee.taxes) {
      rows.push(makeRow({
        id: nextId(),
        orderId: parsed.orderId, currency: parsed.currency,
        scope, jurisdiction: t.jurisdiction, taxType: t.taxType,
        amountCents: t.amountCents, origin, createdAt,
        taxCode: t.taxCode, taxBehavior: t.taxBehavior, engineTaxType: t.engineTaxType,
      }));
    }
  }

  // Invariant: sum(rows) must equal totalTaxCents + deposits.
  const depositSum = parsed.lines.reduce(
    (acc, l) => acc + sumCents(l.deposits),
    0,
  );
  const expected = parsed.totalTaxCents + depositSum;
  // Sum tax rows (not deposit rows) for the engine cross-check.
  const taxRowSum = rows
    .filter((r) => r.taxType !== 'bottle_deposit')
    .reduce((a, r) => a + r.amountCents, 0);

  const drift = parsed.totalTaxCents - taxRowSum;
  if (Math.abs(drift) > ROUNDING_TOLERANCE_CENTS) {
    throw new TaxLedgerInvariantError(
      `split: engine totalTaxCents=${parsed.totalTaxCents} disagrees with summed details=${taxRowSum} by ${drift} cents`,
      { expectedCents: parsed.totalTaxCents, actualCents: taxRowSum, driftCents: drift },
    );
  }
  if (drift !== 0) {
    rows.push(makeRow({
      id: nextId(),
      orderId: parsed.orderId, currency: parsed.currency,
      scope: { kind: 'order', reason: 'rounding_residual' },
      // 'special' jurisdiction makes the row queryable but doesn't claim a real jurisdiction.
      jurisdiction: { type: 'special', code: 'rounding_residual' },
      taxType: 'additional',
      amountCents: drift, origin, createdAt,
    }));
  }

  // Final sanity: the ledger's net (excluding deposits, which are tracked
  // alongside taxes but not summed into totalTax) should equal totalTaxCents.
  const finalTax = rows
    .filter((r) => r.taxType !== 'bottle_deposit')
    .reduce((a, r) => a + r.amountCents, 0);
  if (finalTax !== parsed.totalTaxCents) {
    throw new TaxLedgerInvariantError(
      `split: post-residual tax sum=${finalTax} != totalTaxCents=${parsed.totalTaxCents}`,
      { expectedCents: parsed.totalTaxCents, actualCents: finalTax, driftCents: finalTax - parsed.totalTaxCents },
    );
  }
  const finalDeposit = rows
    .filter((r) => r.taxType === 'bottle_deposit')
    .reduce((a, r) => a + r.amountCents, 0);
  if (finalDeposit !== depositSum) {
    throw new TaxLedgerInvariantError(
      `split: deposit sum=${finalDeposit} != input deposits=${depositSum}`,
      { expectedCents: depositSum, actualCents: finalDeposit, driftCents: finalDeposit - depositSum },
    );
  }
  void expected; // silence unused; kept for readability above.

  return new Ledger(parsed.orderId, parsed.currency, rows);
}

function makeRow(args: {
  id: string;
  orderId: string;
  currency: CurrencyCode;
  scope: LedgerScope;
  jurisdiction: LedgerEntry['jurisdiction'];
  taxType: TaxType;
  amountCents: number;
  origin: LedgerOrigin;
  createdAt: string;
  taxCode?: string;
  taxBehavior?: TaxBehavior;
  engineTaxType?: string;
  quantity?: number;
}): LedgerEntry {
  return {
    id: args.id,
    orderId: args.orderId,
    currency: args.currency,
    scope: args.scope,
    jurisdiction: args.jurisdiction,
    taxType: args.taxType,
    amountCents: args.amountCents,
    taxCode: args.taxCode,
    taxBehavior: args.taxBehavior,
    engineTaxType: args.engineTaxType,
    quantity: args.quantity,
    origin: args.origin,
    createdAt: args.createdAt,
  };
}
