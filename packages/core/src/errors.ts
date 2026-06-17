export class TaxLedgerError extends Error {
  override readonly name: string = 'TaxLedgerError';
}

/** The split or a delta doesn't sum back to its expected total. */
export class TaxLedgerInvariantError extends TaxLedgerError {
  override readonly name = 'TaxLedgerInvariantError';
  constructor(
    message: string,
    public readonly details: {
      expectedCents: number;
      actualCents: number;
      driftCents: number;
    },
  ) {
    super(message);
  }
}

/** Tried to refund more than what remains net on a line/fee. */
export class OverRefundError extends TaxLedgerError {
  override readonly name = 'OverRefundError';
  constructor(
    message: string,
    public readonly details: { lineItemId?: string; feeKind?: string; remainingCents: number; requestedCents: number },
  ) {
    super(message);
  }
}

/** The largest-remainder allocator was handed a non-positive weight set or invalid total. */
export class AllocationError extends TaxLedgerError {
  override readonly name = 'AllocationError';
}

/**
 * Two ledger entries / inputs / deltas were referenced in the same operation
 * with conflicting ISO-4217 currency codes. There's no defensible automatic
 * conversion — the caller must reconcile FX outside the ledger boundary.
 */
export class CurrencyMismatchError extends TaxLedgerError {
  override readonly name = 'CurrencyMismatchError';
  constructor(
    message: string,
    public readonly details: { expected: string; actual: string },
  ) {
    super(message);
  }
}
