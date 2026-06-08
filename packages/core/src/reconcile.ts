import { Ledger } from './ledger.js';
import type { LedgerEntry } from './types.js';
import { TaxLedgerInvariantError } from './errors.js';

export interface ReconcileOptions {
  /**
   * The total the tax engine says it refunded/adjusted (e.g. a Stripe reversal's
   * `amount_tax` total, or an Avalara return doc's `totalTax`). When provided,
   * the delta must sum to it within `toleranceCents` or we throw — this is how
   * you catch drift between what the engine reported and what the ledger
   * actually recorded.
   */
  expectTotalCents?: number;
  /** Allowed absolute drift from `expectTotalCents` before throwing. Default 0. */
  toleranceCents?: number;
}

/**
 * Fold an engine-provided delta (a refund reversal, return document, or
 * revision) into the ledger and verify it.
 *
 * Production tax engines (Stripe Tax reversals, Avalara refund/adjust) are the
 * source of truth for refund tax — they re-quote rather than trusting a local
 * proration. `reconcile` is the other half of that workflow: take the engine's
 * authoritative delta, append it immutably (currency is checked by
 * {@link Ledger.with}), and — given `expectTotalCents` — assert it sums to what
 * the engine reported. Use it to keep a local, queryable ledger that provably
 * agrees with the engine, instead of silently drifting.
 *
 * Returns the new combined {@link Ledger}; throws {@link TaxLedgerInvariantError}
 * on a sum mismatch and `CurrencyMismatchError` on a currency mismatch.
 */
export function reconcile(
  ledger: Ledger,
  delta: ReadonlyArray<LedgerEntry>,
  opts?: ReconcileOptions,
): Ledger {
  if (opts?.expectTotalCents != null) {
    const sum = delta.reduce((a, r) => a + r.amountCents, 0);
    const drift = opts.expectTotalCents - sum;
    const tolerance = opts.toleranceCents ?? 0;
    if (Math.abs(drift) > tolerance) {
      throw new TaxLedgerInvariantError(
        `reconcile: delta sum=${sum} disagrees with engine-reported total=${opts.expectTotalCents} by ${drift} cents`,
        { expectedCents: opts.expectTotalCents, actualCents: sum, driftCents: drift },
      );
    }
  }
  return ledger.with(delta);
}
