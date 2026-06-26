import type { TaxInput, Jurisdiction } from '@tax-ledger/core';
import {
  TaxJarTaxResponseSchema,
  type TaxJarLineItemJurisdictionBreakdown,
} from './schema.js';

type LineTaxType = 'sales' | 'shipping' | 'additional';

/**
 * Options for `toTaxInput` against TaxJar.
 *
 * - `orderId`: the merchant's order identifier. TaxJar's request includes
 *   `transaction_id` but the response does not echo it, so callers must
 *   supply it explicitly. Defaults to `taxjar_<random>` if omitted.
 * - `engineRef`: stored on the ledger. Defaults to `orderId`.
 * - `currency`: ISO-4217. TaxJar doesn't include currency in the response —
 *   the request specifies it. Defaults to `USD`.
 * - `lineItems`: per-line metadata not present on the TaxJar `breakdown`
 *   (TaxJar returns sub-amounts keyed by line id only). The adapter needs
 *   `unitAmountCents` + `quantity` for each line, plus optional deposits.
 * - `shippingFeeAmountCents`: the merchant's shipping fee amount, only used
 *   when `breakdown.shipping` is populated. TaxJar's response carries the
 *   `tax.shipping` field (total shipping value) which we re-use if omitted.
 * - `jurisdictionCodes`: codes for each jurisdiction tier. TaxJar omits the
 *   codes from the `breakdown` rollup (it carries them on `jurisdictions`).
 */
export interface TaxJarAdapterOptions {
  orderId: string;
  engineRef?: string;
  currency?: string;
  lineItems: ReadonlyArray<TaxJarLineMeta>;
  shippingFeeAmountCents?: number;
  jurisdictionCodes?: Partial<{
    country: string;
    state: string;
    county: string;
    city: string;
    special: string;
  }>;
}

export interface TaxJarLineMeta {
  id: string;
  quantity: number;
  unitAmountCents: number;
  deposits?: ReadonlyArray<{ jurisdiction: Jurisdiction; amountCents: number }>;
}

/**
 * Convert a TaxJar `taxes` response into the engine-agnostic `TaxInput`.
 *
 *   tax.amount_to_collect      → totalTaxCents
 *   tax.breakdown.line_items[] → per-line per-jurisdiction sales rows
 *   tax.breakdown.shipping     → shipping fee per-jurisdiction rows
 *
 * The TaxJar breakdown shape is flat: each line has `state_amount`,
 * `county_amount`, `city_amount`, `special_district_amount` directly on
 * the line. The adapter projects those into separate `LineItemTax` rows
 * keyed by jurisdiction tier.
 *
 * Currency is not present in the response — callers supply it (defaults to
 * USD, since TaxJar is US-first).
 */
export function toTaxInput(response: unknown, options: TaxJarAdapterOptions): TaxInput {
  const { tax } = TaxJarTaxResponseSchema.parse(response);
  const currency = (options.currency ?? 'USD').toUpperCase();
  const orderId = options.orderId;
  const engineRef = options.engineRef ?? orderId;
  const codes = resolveJurisdictionCodes(tax, options.jurisdictionCodes);

  const lineMetaById = new Map(options.lineItems.map((l) => [l.id, l]));
  const breakdownLines = tax.breakdown?.line_items ?? [];

  const lines: TaxInput['lines'] = breakdownLines.map((ln) => {
    const meta = lineMetaById.get(ln.id);
    if (!meta) {
      throw new Error(`taxjar adapter: no line metadata supplied for breakdown line id="${ln.id}"`);
    }
    const taxes = buildSalesTaxRows(ln, codes);
    return {
      lineItemId: meta.id,
      quantity: meta.quantity,
      unitAmountCents: meta.unitAmountCents,
      taxes,
      deposits: (meta.deposits ?? []).map((d) => ({ ...d })),
    };
  });

  // If the caller passed lines that don't appear in the breakdown (e.g.
  // a fully-exempt line emits zero amounts and may be skipped by TaxJar
  // historically), include them with empty taxes so the ledger stays
  // line-complete.
  const seen = new Set(breakdownLines.map((b) => b.id));
  for (const meta of options.lineItems) {
    if (seen.has(meta.id)) continue;
    lines.push({
      lineItemId: meta.id,
      quantity: meta.quantity,
      unitAmountCents: meta.unitAmountCents,
      taxes: [],
      deposits: (meta.deposits ?? []).map((d) => ({ ...d })),
    });
  }

  const fees: TaxInput['fees'] = [];
  const shippingBreakdown = tax.breakdown?.shipping;
  const shippingFee = options.shippingFeeAmountCents ?? toCents(tax.shipping);
  if (shippingBreakdown && shippingFee > 0) {
    const shippingTaxes = buildShippingTaxRows(shippingBreakdown, codes);
    fees.push({
      feeKind: 'shipping',
      amountCents: shippingFee,
      taxes: shippingTaxes,
    });
  } else if (shippingFee > 0) {
    fees.push({ feeKind: 'shipping', amountCents: shippingFee, taxes: [] });
  }

  return {
    orderId,
    currency,
    engineRef,
    totalTaxCents: toCents(tax.amount_to_collect),
    lines,
    fees,
  };
}

interface ResolvedCodes {
  country?: string;
  state?: string;
  county?: string;
  city?: string;
  special?: string;
}

function resolveJurisdictionCodes(
  tax: { jurisdictions?: { country?: string; state?: string; county?: string; city?: string } },
  override?: TaxJarAdapterOptions['jurisdictionCodes'],
): ResolvedCodes {
  return {
    country: override?.country ?? tax.jurisdictions?.country?.toUpperCase(),
    state: override?.state ?? tax.jurisdictions?.state?.toUpperCase(),
    county: override?.county ?? tax.jurisdictions?.county?.toUpperCase(),
    city: override?.city ?? tax.jurisdictions?.city?.toUpperCase(),
    special: override?.special,
  };
}

function buildSalesTaxRows(
  ln: TaxJarLineItemJurisdictionBreakdown,
  codes: ResolvedCodes,
): Array<{ jurisdiction: Jurisdiction; taxType: LineTaxType; amountCents: number }> {
  const rows: Array<{ jurisdiction: Jurisdiction; taxType: LineTaxType; amountCents: number }> = [];
  const push = (
    type: Jurisdiction['type'],
    code: string | undefined,
    amount: number | undefined,
  ): void => {
    const cents = toCents(amount ?? 0);
    if (cents <= 0) return;
    rows.push({
      jurisdiction: { type, code: code ?? 'UNKNOWN' },
      taxType: 'sales',
      amountCents: cents,
    });
  };
  push('state', codes.state, ln.state_amount);
  push('county', codes.county, ln.county_amount);
  push('city', codes.city, ln.city_amount);
  push('special', codes.special ?? codes.state, ln.special_district_amount);
  return rows;
}

function buildShippingTaxRows(
  br: TaxJarLineItemJurisdictionBreakdown,
  codes: ResolvedCodes,
): Array<{ jurisdiction: Jurisdiction; taxType: LineTaxType; amountCents: number }> {
  const rows: Array<{ jurisdiction: Jurisdiction; taxType: LineTaxType; amountCents: number }> = [];
  const push = (
    type: Jurisdiction['type'],
    code: string | undefined,
    amount: number | undefined,
  ): void => {
    const cents = toCents(amount ?? 0);
    if (cents <= 0) return;
    rows.push({
      jurisdiction: { type, code: code ?? 'UNKNOWN' },
      taxType: 'shipping',
      amountCents: cents,
    });
  };
  push('state', codes.state, br.state_amount);
  push('county', codes.county, br.county_amount);
  push('city', codes.city, br.city_amount);
  push('special', codes.special ?? codes.state, br.special_district_amount);
  return rows;
}

function toCents(dollars: number): number {
  if (!Number.isFinite(dollars)) return 0;
  return Math.round(dollars * 100 + Number.EPSILON);
}
