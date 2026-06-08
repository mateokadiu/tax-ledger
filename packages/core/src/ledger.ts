import { CurrencyMismatchError } from './errors.js';
import type { CurrencyCode, LedgerEntry, TaxType } from './types.js';

/** Net cents grouped into the canonical tax components. */
export interface ComponentTotals {
  salesTax: number;
  shippingTax: number;
  bottleDeposits: number;
  vat: number;
  additional: number;
  /** Sum of every component (== the ledger's net cents). */
  total: number;
}

/** A dimension to group ledger rows by in {@link Ledger.rollupBy}. */
export type RollupDimension =
  | 'taxType'
  | 'jurisdictionType'
  | 'jurisdictionCode'
  | 'scope'
  | 'origin'
  | 'currency';

export interface RollupRow {
  /** The grouped dimension values, e.g. `{ taxType: 'sales', jurisdictionType: 'state' }`. */
  key: Record<string, string>;
  /** Net cents in this group. */
  amountCents: number;
  /** Number of ledger rows in this group. */
  count: number;
}

/**
 * Append-only collection of ledger entries for a single order. Returned by
 * `split()` and threaded through reconcile ops. `with()` creates a new ledger
 * with delta rows appended — never mutates.
 *
 * Every entry in `rows` shares the ledger's `currency` (ISO-4217). Mixing
 * currencies in a single ledger is a domain error — cross-currency
 * reconciliation goes through a separate FX-aware boundary upstream.
 */
export class Ledger {
  readonly rows: ReadonlyArray<LedgerEntry>;

  constructor(
    readonly orderId: string,
    readonly currency: CurrencyCode,
    rows: ReadonlyArray<LedgerEntry>,
  ) {
    this.rows = rows;
  }

  /**
   * Append delta rows immutably. Refuses rows whose currency does not match
   * the ledger's — cross-currency reconciliation has to be resolved upstream
   * before the FX-adjusted figures hit the ledger.
   */
  with(delta: ReadonlyArray<LedgerEntry>): Ledger {
    if (delta.length === 0) return this;
    for (const r of delta) {
      if (r.currency !== this.currency) {
        throw new CurrencyMismatchError(
          `cannot append entry in ${r.currency} to ledger denominated in ${this.currency}`,
          { expected: this.currency, actual: r.currency },
        );
      }
    }
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

  /**
   * Net cents grouped into the canonical tax components — one figure per bucket
   * that sums back to the ledger's net. This is the shape downstream accounting
   * and payment systems usually need (the "split a flat tax total into sales /
   * shipping / bottle-deposit / vat / additional" problem).
   */
  toComponentTotals(): ComponentTotals {
    let salesTax = 0;
    let shippingTax = 0;
    let bottleDeposits = 0;
    let vat = 0;
    let additional = 0;
    for (const r of this.rows) {
      switch (r.taxType) {
        case 'sales': salesTax += r.amountCents; break;
        case 'shipping': shippingTax += r.amountCents; break;
        case 'bottle_deposit': bottleDeposits += r.amountCents; break;
        case 'vat': vat += r.amountCents; break;
        case 'additional': additional += r.amountCents; break;
      }
    }
    return {
      salesTax,
      shippingTax,
      bottleDeposits,
      vat,
      additional,
      total: salesTax + shippingTax + bottleDeposits + vat + additional,
    };
  }

  /**
   * Group rows by one or more dimensions and sum their cents — the roll-ups a
   * BYO-DB consumer would otherwise hand-write in SQL (by jurisdiction, by tax
   * type, by origin, …). Returns one {@link RollupRow} per distinct key tuple.
   */
  rollupBy(dimensions: ReadonlyArray<RollupDimension>): RollupRow[] {
    const groups = new Map<string, RollupRow>();
    for (const r of this.rows) {
      const key: Record<string, string> = {};
      for (const d of dimensions) key[d] = dimensionValue(r, d);
      const composite = dimensions.map((d) => `${d}=${key[d]}`).join('|');
      const existing = groups.get(composite);
      if (existing) {
        existing.amountCents += r.amountCents;
        existing.count += 1;
      } else {
        groups.set(composite, { key, amountCents: r.amountCents, count: 1 });
      }
    }
    return [...groups.values()];
  }
}

function dimensionValue(r: LedgerEntry, d: RollupDimension): string {
  switch (d) {
    case 'taxType': return r.taxType;
    case 'jurisdictionType': return r.jurisdiction.type;
    case 'jurisdictionCode': return r.jurisdiction.code;
    case 'scope': return r.scope.kind;
    case 'origin': return r.origin.kind;
    case 'currency': return r.currency;
  }
}
