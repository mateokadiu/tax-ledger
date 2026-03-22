import { Decimal } from 'decimal.js';

// Decimal config: 40 significant digits is plenty for cents at any realistic
// transaction volume. ROUND_HALF_EVEN is banker's rounding — neutral over time.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export type DecimalLike = Decimal;
export { Decimal };

export const ZERO: DecimalLike = new Decimal(0);
export const ONE: DecimalLike = new Decimal(1);

export function dec(value: Decimal.Value): DecimalLike {
  return new Decimal(value);
}

/** Sum a list of integer cents. Returns native number — caller is responsible for overflow domain. */
export function sumCents(rows: ReadonlyArray<{ amountCents: number }>): number {
  let total = 0;
  for (const r of rows) total += r.amountCents;
  return total;
}
