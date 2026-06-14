import { dec } from './money.js';

/**
 * ISO 4217 minor-unit exponents that differ from the default of 2.
 *
 * The ledger works in integer minor units. For currencies that aren't
 * 2-decimal — JPY (0), KWD (3), … — converting an engine-supplied major amount
 * with a hard-coded `* 100` is wrong. These helpers make the exponent explicit
 * so multi-currency ledgers are honest rather than implicitly "cents".
 */
const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  // zero-decimal
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // three-decimal
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // four-decimal
  CLF: 4,
};

const DEFAULT_EXPONENT = 2;

/** Minor-unit exponent for an ISO-4217 code (USD→2, JPY→0, KWD→3). Defaults to 2. */
export function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENTS[currency.toUpperCase()] ?? DEFAULT_EXPONENT;
}

/**
 * Convert a major-unit amount (e.g. dollars) to integer minor units for
 * `currency`, using banker's rounding. `toMinorUnits(1.234, 'KWD') === 1234`.
 */
export function toMinorUnits(amount: number | string, currency: string): number {
  const factor = 10 ** minorUnitExponent(currency);
  return dec(amount).times(factor).round().toNumber();
}

/** Convert integer minor units back to a major-unit number for `currency`. */
export function fromMinorUnits(minor: number, currency: string): number {
  const factor = 10 ** minorUnitExponent(currency);
  return dec(minor).div(factor).toNumber();
}

/** Format integer minor units as a fixed-decimal string (1234 USD → "12.34", 1000 JPY → "1000"). */
export function formatMinorUnits(minor: number, currency: string): string {
  const exp = minorUnitExponent(currency);
  return dec(minor).div(10 ** exp).toFixed(exp);
}
