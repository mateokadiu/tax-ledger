import {
  RefundSpecSchema,
  type LedgerEntry,
  type LedgerOrigin,
  type RefundSpec,
} from './types.js';
import { OverRefundError, TaxLedgerError } from './errors.js';
import { allocate } from './allocator.js';
import { dec } from './money.js';
import { resolveContext, type LedgerOptions } from './context.js';
import type { Ledger } from './ledger.js';

/**
 * Refund a set of line items and/or fees. Returns a delta — an array of
 * ledger entries with origin={ kind: 'refund', refundId } and signed
 * (negative) amountCents.
 *
 * Allocation strategy: for each refunded line, resolve the cents to remove
 * (either supplied directly or derived from a quantity), then allocate that
 * amount across the line's rows with largest-remainder so the per-(jurisdiction,
 * taxType) buckets sum back exactly. Deposits are treated identically to taxes.
 *
 * The refund spec can express either:
 *   - quantity-based refund (refund N units of line L)
 *   - cents-based refund (refund $X of value on line L)
 *
 * Throws OverRefundError if the requested refund exceeds the current remaining
 * quantity / value on a line or fee. Pass `opts` ({ now, generateId }) for
 * deterministic, replayable output.
 */
export function refund(ledger: Ledger, spec: RefundSpec, opts?: LedgerOptions): LedgerEntry[] {
  const parsed = RefundSpecSchema.parse(spec);
  const origin: LedgerOrigin = { kind: 'refund', refundId: parsed.refundId };
  const { createdAt, nextId } = resolveContext(opts);
  const delta: LedgerEntry[] = [];

  for (const refundLine of parsed.lines) {
    const rows = ledger.rowsForLine(refundLine.lineItemId);
    if (rows.length === 0) continue;

    const remainingNet = rows.reduce((a, r) => a + r.amountCents, 0);
    if (remainingNet <= 0) {
      throw new OverRefundError(
        `cannot refund line ${refundLine.lineItemId}: remainingNet=${remainingNet}`,
        { lineItemId: refundLine.lineItemId, remainingCents: remainingNet, requestedCents: 0 },
      );
    }

    // Resolve the refund magnitude (cents to remove from the line's net).
    let refundCents: number;
    if (refundLine.amountCents != null) {
      refundCents = refundLine.amountCents;
    } else {
      // quantity-based: refund a proportional slice of the remaining net.
      const remainingQty = computeRemainingQuantity(ledger, refundLine.lineItemId);
      if (remainingQty == null) {
        throw new TaxLedgerError(
          `cannot refund ${refundLine.quantity} units of ${refundLine.lineItemId}: the ledger has no persisted line quantity — pass amountCents instead`,
        );
      }
      if (refundLine.quantity! > remainingQty) {
        throw new OverRefundError(
          `cannot refund ${refundLine.quantity} units of ${refundLine.lineItemId}: remaining qty=${remainingQty}`,
          {
            lineItemId: refundLine.lineItemId,
            remainingCents: remainingNet,
            requestedCents: remainingNet,
          },
        );
      }
      // exact = remainingNet * qty / remainingQty. We don't compute a
      // line-level total — allocateRefundOverRows re-distributes per row so
      // each (jurisdiction, taxType) bucket sums right.
      refundCents = dec(remainingNet).times(refundLine.quantity!).div(remainingQty).round().toNumber();
    }

    if (refundCents > remainingNet) {
      throw new OverRefundError(
        `cannot refund ${refundCents} cents from line ${refundLine.lineItemId}: remaining=${remainingNet}`,
        { lineItemId: refundLine.lineItemId, remainingCents: remainingNet, requestedCents: refundCents },
      );
    }
    if (refundCents <= 0) continue;

    delta.push(
      ...allocateRefundOverRows({
        sourceRows: rows,
        refundCents,
        origin,
        createdAt,
        nextId,
      }),
    );
  }

  for (const refundFee of parsed.fees) {
    const rows = ledger.rowsForFee(refundFee.feeKind);
    if (rows.length === 0) continue;

    const remainingNet = rows.reduce((a, r) => a + r.amountCents, 0);
    if (remainingNet <= 0) {
      throw new OverRefundError(
        `cannot refund fee ${refundFee.feeKind}: remainingNet=${remainingNet}`,
        { feeKind: refundFee.feeKind, remainingCents: remainingNet, requestedCents: 0 },
      );
    }
    const refundCents = refundFee.amountCents ?? remainingNet;
    if (refundCents > remainingNet) {
      throw new OverRefundError(
        `cannot refund ${refundCents} cents from fee ${refundFee.feeKind}: remaining=${remainingNet}`,
        { feeKind: refundFee.feeKind, remainingCents: remainingNet, requestedCents: refundCents },
      );
    }
    if (refundCents <= 0) continue;

    delta.push(
      ...allocateRefundOverRows({
        sourceRows: rows,
        refundCents,
        origin,
        createdAt,
        nextId,
      }),
    );
  }

  return delta;
}

/**
 * Recover a line's remaining quantity from its ledger rows. We persist the
 * original quantity on every split-origin line row, so:
 *
 *   remainingQty = round(currentNet * originalQty / originalNet)
 *
 * where `originalNet` is the line's split-time net and `currentNet` folds in
 * any refund/capture deltas already applied. This matches how a proportional
 * partial refund actually scales the line.
 *
 * Returns `null` when the quantity can't be determined (a ledger constructed
 * without `split`, or pre-quantity data) — callers should fall back to an
 * explicit `amountCents` refund.
 */
function computeRemainingQuantity(ledger: Ledger, lineItemId: string): number | null {
  const lineRows = ledger.rowsForLine(lineItemId);
  const splitRows = lineRows.filter((r) => r.origin.kind === 'split');
  const originalQty = splitRows.find((r) => r.quantity != null)?.quantity;
  if (originalQty == null || originalQty <= 0) return null;
  const originalNet = splitRows.reduce((a, r) => a + r.amountCents, 0);
  if (originalNet <= 0) return null;
  const currentNet = lineRows.reduce((a, r) => a + r.amountCents, 0);
  const remaining = Math.round((currentNet * originalQty) / originalNet);
  return Math.max(0, Math.min(originalQty, remaining));
}

interface AllocateOverRowsArgs {
  sourceRows: ReadonlyArray<LedgerEntry>;
  refundCents: number;
  origin: LedgerOrigin;
  createdAt: string;
  nextId: () => string;
}

/**
 * Allocate `refundCents` proportionally across `sourceRows` using
 * largest-remainder, and emit a negative delta row per source row. Per-row
 * weight = the row's current amountCents.
 *
 * The allocation key is the row's stable position (zero-padded) rather than
 * its id, so the residual cent lands deterministically on the same bucket
 * regardless of (possibly random) row ids — replay-stable by construction.
 */
function allocateRefundOverRows(args: AllocateOverRowsArgs): LedgerEntry[] {
  const positiveRows = args.sourceRows.filter((r) => r.amountCents > 0);
  if (positiveRows.length === 0) return [];

  const key = (i: number): string => String(i).padStart(8, '0');
  const items = positiveRows.map((r, i) => ({ key: key(i), weight: dec(r.amountCents) }));
  const allocation = allocate(args.refundCents, items);
  const out: LedgerEntry[] = [];

  for (let i = 0; i < positiveRows.length; i++) {
    const r = positiveRows[i]!;
    const refundedCents = allocation.get(key(i)) ?? 0;
    if (refundedCents === 0) continue;
    out.push({
      id: args.nextId(),
      orderId: r.orderId,
      currency: r.currency,
      scope: r.scope,
      jurisdiction: r.jurisdiction,
      taxType: r.taxType,
      amountCents: -refundedCents, // refund is a negative delta
      taxCode: r.taxCode,
      taxBehavior: r.taxBehavior,
      engineTaxType: r.engineTaxType,
      origin: args.origin,
      createdAt: args.createdAt,
    });
  }

  return out;
}
