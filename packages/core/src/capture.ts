import { uuidv7 } from './ids.js';
import {
  CaptureSpecSchema,
  type CaptureSpec,
  type LedgerEntry,
  type LedgerOrigin,
} from './types.js';
import { TaxLedgerInvariantError } from './errors.js';
import { allocate } from './allocator.js';
import { dec } from './money.js';
import type { Ledger } from './ledger.js';

/**
 * Partial capture: when the merchant captures less than the auth amount, the
 * taxes owed scale down proportionally. We emit negative delta rows for the
 * *uncaptured* portion of every tax/deposit row in the live ledger.
 *
 * captureSpec.capturedAmountCents / captureSpec.originalAmountCents == capture ratio
 * uncaptured = liveNet * (1 - ratio)
 *
 * If capturedAmountCents >= originalAmountCents, no delta — auth amount was
 * captured in full (or over-captured, which is an upstream PSP problem).
 *
 * Allocation: largest-remainder across all positive-net rows of the live
 * ledger so the per-row signed integer cents sum exactly to the uncaptured
 * total.
 */
export function partialCapture(ledger: Ledger, spec: CaptureSpec): LedgerEntry[] {
  const parsed = CaptureSpecSchema.parse(spec);
  if (parsed.capturedAmountCents > parsed.originalAmountCents) {
    throw new TaxLedgerInvariantError(
      `capture: captured ${parsed.capturedAmountCents} > original ${parsed.originalAmountCents}`,
      {
        expectedCents: parsed.originalAmountCents,
        actualCents: parsed.capturedAmountCents,
        driftCents: parsed.capturedAmountCents - parsed.originalAmountCents,
      },
    );
  }
  if (parsed.capturedAmountCents === parsed.originalAmountCents) return [];

  const origin: LedgerOrigin = { kind: 'capture', captureId: parsed.captureId };
  const createdAt = new Date().toISOString();
  const positiveRows = ledger.rows.filter((r) => r.amountCents > 0);
  if (positiveRows.length === 0) return [];

  // uncaptured fraction = (original - captured) / original
  const liveNet = positiveRows.reduce((a, r) => a + r.amountCents, 0);
  if (liveNet <= 0) return [];

  const uncapturedFraction = dec(parsed.originalAmountCents - parsed.capturedAmountCents).div(parsed.originalAmountCents);
  const uncapturedCents = dec(liveNet).times(uncapturedFraction).round().toNumber();
  if (uncapturedCents <= 0) return [];

  const items = positiveRows.map((r) => ({ key: r.id, weight: dec(r.amountCents) }));
  const allocation = allocate(uncapturedCents, items);

  const out: LedgerEntry[] = [];
  for (const r of positiveRows) {
    const cents = allocation.get(r.id) ?? 0;
    if (cents === 0) continue;
    out.push({
      id: uuidv7(),
      orderId: r.orderId,
      currency: r.currency,
      scope: r.scope,
      jurisdiction: r.jurisdiction,
      taxType: r.taxType,
      amountCents: -cents, // uncaptured portion is removed
      origin,
      createdAt,
    });
  }

  return out;
}
