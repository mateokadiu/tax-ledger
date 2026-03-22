import type { LedgerEntry, TaxType } from './types.js';

/**
 * Append-only collection of ledger entries for a single order. Returned by
 * `split()` and threaded through reconcile ops. `with()` creates a new ledger
 * with delta rows appended — never mutates.
 */
export class Ledger {
  readonly rows: ReadonlyArray<LedgerEntry>;

  constructor(
    readonly orderId: string,
    readonly currency: string,
    rows: ReadonlyArray<LedgerEntry>,
  ) {
    this.rows = rows;
  }

  /** Append delta rows immutably. */
  with(delta: ReadonlyArray<LedgerEntry>): Ledger {
    if (delta.length === 0) return this;
    return new Ledger(this.orderId, this.currency, [...this.rows, ...delta]);
  }

  /** Net cents across the whole ledger, optionally filtered. */
  netCents(filter?: {
    taxType?: TaxType;
    jurisdictionType?: string;
    scope?: 'line' | 'fee' | 'order';
    lineItemId?: string;
    feeKind?: string;
  }): number {
    let total = 0;
    for (const r of this.rows) {
      if (filter?.taxType && r.taxType !== filter.taxType) continue;
      if (filter?.jurisdictionType && r.jurisdiction.type !== filter.jurisdictionType) continue;
      if (filter?.scope && r.scope.kind !== filter.scope) continue;
      if (filter?.lineItemId) {
        if (r.scope.kind !== 'line' || r.scope.lineItemId !== filter.lineItemId) continue;
      }
      if (filter?.feeKind) {
        if (r.scope.kind !== 'fee' || r.scope.feeKind !== filter.feeKind) continue;
      }
      total += r.amountCents;
    }
    return total;
  }

  /** Rows tagged to a specific line item. */
  rowsForLine(lineItemId: string): ReadonlyArray<LedgerEntry> {
    return this.rows.filter((r) => r.scope.kind === 'line' && r.scope.lineItemId === lineItemId);
  }

  /** Rows tagged to a specific fee. */
  rowsForFee(feeKind: string): ReadonlyArray<LedgerEntry> {
    return this.rows.filter((r) => r.scope.kind === 'fee' && r.scope.feeKind === feeKind);
  }
}
