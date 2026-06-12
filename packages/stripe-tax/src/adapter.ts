import type { TaxInput, Jurisdiction, JurisdictionType } from '@tax-ledger/core';
import {
  StripeTaxCalculationSchema,
  type StripeTaxBreakdown,
  type StripeTaxJurisdiction,
} from './schema.js';

type LineTaxType = 'sales' | 'shipping' | 'vat' | 'additional';

/**
 * Options for `toTaxInput` against Stripe Tax.
 *
 * - `orderId`: stored on the ledger. Defaults to the calculation `id` (which
 *   is `null` for ephemeral calculations — pass it explicitly when that's
 *   the case).
 * - `engineRef`: defaults to the calculation `id` or `orderId`.
 * - `lineItemIdResolver`: by default we use Stripe's `reference` field (the
 *   merchant-supplied external id) and fall back to `id`. Pass a resolver
 *   to override.
 * - `feeKindForShipping`: the `feeKind` to use for the shipping_cost entry.
 *   Defaults to `shipping`.
 */
export interface StripeTaxAdapterOptions {
  orderId?: string;
  engineRef?: string;
  lineItemIdResolver?: (
    raw: { id?: string; reference?: string; product?: string | null; index: number },
  ) => string;
  feeKindForShipping?: string;
}

/**
 * Convert a Stripe `Tax.Calculation` object into the engine-agnostic
 * `TaxInput`.
 *
 *   calc.tax_amount_exclusive         → totalTaxCents
 *   calc.currency.toUpperCase()       → currency
 *   line.amount + line.quantity       → line totals
 *   line.tax_breakdown[]              → per-jurisdiction rows
 *   calc.shipping_cost                → fee (kind: 'shipping')
 *
 * Inclusive tax: Stripe supports tax inclusive of the line amount. The
 * splitter treats tax cents as already-computed regardless of whether they
 * were quoted inclusive or exclusive — we faithfully reflect the
 * breakdown's `amount` on every row. `tax_amount_inclusive` and
 * `tax_amount_exclusive` are exposed separately by Stripe; we sum the
 * exclusive total only, since inclusive tax is collected at sale.
 */
export function toTaxInput(
  calculation: unknown,
  options: StripeTaxAdapterOptions = {},
): TaxInput {
  const calc = StripeTaxCalculationSchema.parse(calculation);
  const lineIdResolver =
    options.lineItemIdResolver ??
    (({ id, reference, index }: { id?: string; reference?: string; index: number }) =>
      reference ?? id ?? `line_${index}`);

  const lines: TaxInput['lines'] = calc.line_items.map((ln, index) => {
    const lineItemId = lineIdResolver({
      id: ln.id,
      reference: ln.reference,
      product: ln.product ?? undefined,
      index,
    });
    const qty = ln.quantity;
    const unitAmountCents = Math.max(0, Math.floor(ln.amount / qty));
    const taxes = ln.tax_breakdown
      .filter((b) => b.amount > 0)
      .map((b) => ({
        jurisdiction: mapJurisdiction(b.jurisdiction),
        taxType: mapTaxType(b),
        amountCents: b.amount,
        taxCode: ln.tax_code,
        taxBehavior: normalizeBehavior(ln.tax_behavior),
        engineTaxType: b.tax_rate_details?.tax_type,
      }));
    return {
      lineItemId,
      quantity: qty,
      unitAmountCents,
      taxes,
      deposits: [],
    };
  });

  const fees: TaxInput['fees'] = [];
  const shippingFeeKind = options.feeKindForShipping ?? 'shipping';
  const shippingCost = calc.shipping_cost;
  if (shippingCost && shippingCost.amount > 0) {
    const shippingTaxes = shippingCost.tax_breakdown
      .filter((b) => b.amount > 0)
      .map((b) => ({
        jurisdiction: mapJurisdiction(b.jurisdiction),
        taxType: 'shipping' as const,
        amountCents: b.amount,
        taxCode: shippingCost.tax_code,
        taxBehavior: normalizeBehavior(shippingCost.tax_behavior),
        engineTaxType: b.tax_rate_details?.tax_type,
      }));
    fees.push({
      feeKind: shippingFeeKind,
      amountCents: shippingCost.amount,
      taxes: shippingTaxes,
    });
  }

  const orderId = options.orderId ?? calc.id ?? 'stripe_tax_calc';
  return {
    orderId,
    currency: calc.currency.toUpperCase(),
    engineRef: options.engineRef ?? calc.id ?? orderId,
    totalTaxCents: calc.tax_amount_exclusive,
    lines,
    fees,
  };
}

function mapJurisdiction(j: StripeTaxJurisdiction): Jurisdiction {
  const level = mapLevel(j.level);
  const code = pickJurisdictionCode(j, level);
  return {
    type: level,
    code,
    country: j.country.toUpperCase(),
    region: j.state,
    name: j.display_name,
  };
}

function mapLevel(level: StripeTaxJurisdiction['level']): JurisdictionType {
  switch (level) {
    case 'country':
      return 'country';
    case 'state':
      return 'state';
    case 'county':
      return 'county';
    case 'city':
      return 'city';
    case 'district':
    case 'special':
    default:
      return 'special';
  }
}

function pickJurisdictionCode(
  j: StripeTaxJurisdiction,
  level: JurisdictionType,
): string {
  if (level === 'country') return j.country.toUpperCase();
  if (level === 'state') {
    return j.state ?? j.display_name ?? j.country.toUpperCase();
  }
  // For county / city / special — Stripe puts the canonical label in
  // `display_name`. Pair it with the state to keep codes unique
  // across states (e.g. NY-NYC, CA-OAK).
  const sub = j.display_name ?? '';
  const prefix = j.state ?? j.country.toUpperCase();
  return sub ? `${prefix}-${sub.toUpperCase().replace(/\s+/g, '_')}` : prefix;
}

function mapTaxType(b: StripeTaxBreakdown): LineTaxType {
  const t = b.tax_rate_details?.tax_type?.toLowerCase() ?? '';
  if (t === 'retail_delivery_fee') return 'additional';
  // Value-added family: EU VAT, Canada/India GST/HST/IGST, Japan JCT, etc.
  if (
    t.includes('vat') || t.includes('gst') || t.includes('hst') ||
    t === 'igst' || t === 'jct' || t === 'pst' || t === 'qst'
  ) {
    return 'vat';
  }
  if (t.includes('shipping')) return 'shipping';
  // sales_tax, rst, or unspecified → US-style sales tax. Shipping tax actually
  // arrives via `shipping_cost.tax_breakdown`, mapped to 'shipping' at the caller.
  return 'sales';
}

/** Stripe's `tax_behavior` is `inclusive`|`exclusive`; pass through, else drop. */
function normalizeBehavior(b: string | undefined): 'inclusive' | 'exclusive' | undefined {
  return b === 'inclusive' || b === 'exclusive' ? b : undefined;
}
