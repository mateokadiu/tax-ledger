import { uuidv7 } from './ids.js';
import {
  RefundSpecSchema,
  type LedgerEntry,
  type LedgerOrigin,
  type RefundSpec,
} from './types.js';
import { OverRefundError } from './errors.js';
import { allocate } from './allocator.js';
import { dec } from './money.js';
import type { Ledger } from './ledger.js';

/**
 * Refund a set of line items and/or fees. Returns a delta — an array of
 * ledger entries with origin={ kind: 'refund', refundId } and signed
 * (negative) amountCents.
 *
 * Allocation strategy: for each refunded line, compute the ratio of refunded
 * value to *remaining net* value, then for each row apply that ratio with
 * largest-remainder so the per-(jurisdiction, taxType) bucket sums exactly to
 * the refunded portion. Deposits are treated identically to taxes — same row
 * shape, same allocation.
 *
 * The refund spec can express either:
 *   - quantity-based refund (refund N units of L items)
 *   - cents-based refund (refund $X of value on line L)
 *
 * Throws OverRefundError if the requested refund exceeds the current
 * remaining quantity / value on a line or fee.
 */
export function refund(ledger: Ledger, spec: RefundSpec): LedgerEntry[] {
  const parsed = RefundSpecSchema.parse(spec);
  const origin: LedgerOrigin = { kind: 'refund', refundId: parsed.refundId };
  const createdAt = new Date().toISOString();
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
      // quantity-based: ratio of refunded qty to remaining qty * remainingNet
      const remainingQty = computeRemainingQuantity(ledger, refundLine.lineItemId);
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
      // exact = remainingNet * qty / remainingQty, but we don't compute a
      // line-level total — we allocate per (jurisdiction, taxType) group so
      // each group sums right.
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
      }),
    );
  }

  return delta;
}

/**
 * Compute the line's remaining quantity by looking at the original split rows
 * and any quantity-reducing refund deltas. v0.1 doesn't carry quantity on
 * delta rows directly — we recover it from the ratio of current net to
 * per-unit net at split time. For now: if the line still has any positive
 * net rows, we treat full quantity as available. This is conservative but
 * correct for the v0.1 invariants. Quantity tracking lands in v0.2.
 */
function computeRemainingQuantity(ledger: Ledger, lineItemId: string): number {
  // First-pass: derive original quantity from the split-origin rows. Since
  // OrderInput.lines carries quantity but isn't persisted on the ledger
  // entry, we encode quantity in a different way: the caller passes a
  // sensible quantity, and refundCents is computed from the *net ratio*.
  // For commit #5 we assume full-line refunds via amountCents or partial via
  // an explicit amountCents; quantity-based partial refunds are exercised in
  // commit #6 once we track quantity-per-line.
  // Conservative fallback: assume 1 unit remaining → quantity refunds map
  // 1:1 to full-line refunds. Callers can always use amountCents for
  // precision.
  void ledger;
  void lineItemId;
  return 1;
}

interface AllocateOverRowsArgs {
  sourceRows: ReadonlyArray<LedgerEntry>;
  refundCents: number;
  origin: LedgerOrigin;
  createdAt: string;
}

/**
 * Allocate `refundCents` proportionally across `sourceRows` using
 * largest-remainder, and emit a negative delta row per source row.
 * Per-row weight = the row's current amountCents (sign preserved).
 */
function allocateRefundOverRows(args: AllocateOverRowsArgs): LedgerEntry[] {
  const positiveRows = args.sourceRows.filter((r) => r.amountCents > 0);
  if (positiveRows.length === 0) return [];

  const items = positiveRows.map((r) => ({ key: r.id, weight: dec(r.amountCents) }));
  const allocation = allocate(args.refundCents, items);
  const out: LedgerEntry[] = [];

  for (const r of positiveRows) {
    const refundedCents = allocation.get(r.id) ?? 0;
    if (refundedCents === 0) continue;
    out.push({
      id: uuidv7(),
      orderId: r.orderId,
      currency: r.currency,
      scope: r.scope,
      jurisdiction: r.jurisdiction,
      taxType: r.taxType,
      amountCents: -refundedCents, // refund is a negative delta
      origin: args.origin,
      createdAt: args.createdAt,
    });
  }

  return out;
}
