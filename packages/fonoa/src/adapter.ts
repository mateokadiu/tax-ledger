import { toMinorUnits, type TaxInput, type Jurisdiction, type JurisdictionType } from '@tax-ledger/core';
import { FonoaCalculationSchema, type FonoaItemResult } from './schema.js';

type LineTax = NonNullable<TaxInput['lines'][number]['taxes']>[number];

/**
 * Options for `toTaxInput` against Fonoa Tax.
 *
 * - `currency`: ISO-4217. Fonoa's calculation response doesn't echo the
 *   currency, so the caller supplies it (it's a request input). Required.
 * - `orderId` / `engineRef`: default to the calculation `id` (a UUID).
 * - `priceIncludesTax`: whether prices were quoted tax-inclusive (the request's
 *   `transaction.price_includes_tax`). Sets `taxBehavior` on emitted rows.
 * - `lineQuantities`: per-item quantity (item id → qty). Fonoa's response items
 *   don't carry quantity; supply it to enable quantity-based refunds. Default 1.
 * - `countryCode`: fallback ISO-3166 country for a breakdown row that omits one.
 */
export interface FonoaAdapterOptions {
  currency: string;
  orderId?: string;
  engineRef?: string;
  priceIncludesTax?: boolean;
  lineQuantities?: Readonly<Record<string, number>>;
  countryCode?: string;
}

/**
 * Convert a Fonoa `Tax` calculation response into the engine-agnostic
 * `TaxInput`.
 *
 *   result.total_indirect_tax_amount   → totalTaxCents
 *   result.items[]                     → lines
 *   item.tax_breakdown[]               → per-jurisdiction VAT rows
 *
 * VAT is national, so jurisdictions default to `country` level. Reverse-charge
 * / exempt lines come back from Fonoa with zero tax and simply emit no tax
 * rows. Tax-inclusive pricing is reflected via `taxBehavior` (set from
 * `priceIncludesTax`), since Fonoa quotes tax inclusive or exclusive per the
 * request.
 */
export function toTaxInput(calculation: unknown, options: FonoaAdapterOptions): TaxInput {
  const calc = FonoaCalculationSchema.parse(calculation);
  const currency = options.currency.toUpperCase();
  const engineRef = options.engineRef ?? calc.id;
  const orderId = options.orderId ?? calc.id;
  const behavior = options.priceIncludesTax ? 'inclusive' : 'exclusive';

  const lines: TaxInput['lines'] = calc.result.items.map((item) => {
    const qty = options.lineQuantities?.[item.id] ?? 1;
    const netMinor = toMinorUnits(item.net_amount ?? 0, currency);
    const unitAmountCents = qty > 0 ? Math.max(0, Math.floor(netMinor / qty)) : netMinor;
    return {
      lineItemId: item.id,
      quantity: qty,
      unitAmountCents,
      taxes: buildTaxes(item, currency, behavior, options.countryCode),
      deposits: [],
    };
  });

  return {
    orderId,
    currency,
    engineRef,
    totalTaxCents: toMinorUnits(calc.result.total_indirect_tax_amount, currency),
    lines,
    fees: [],
  };
}

function buildTaxes(
  item: FonoaItemResult,
  currency: string,
  behavior: 'inclusive' | 'exclusive',
  fallbackCountry: string | undefined,
): LineTax[] {
  const rows: LineTax[] = item.tax_breakdown
    .filter((b) => toMinorUnits(b.amount, currency) > 0)
    .map((b) => ({
      jurisdiction: buildJurisdiction(b.tax_level, b.country ?? fallbackCountry, b.country_name),
      taxType: mapTaxName(b.name),
      amountCents: toMinorUnits(b.amount, currency),
      taxBehavior: behavior,
      engineTaxType: b.name,
      taxCode: b.rate_class,
    }));

  // No per-jurisdiction breakdown but a non-zero indirect tax: emit a single
  // national VAT row so the figure still lands on the ledger.
  if (rows.length === 0 && toMinorUnits(item.indirect_tax_amount, currency) > 0) {
    rows.push({
      jurisdiction: buildJurisdiction('country', fallbackCountry, undefined),
      taxType: 'vat',
      amountCents: toMinorUnits(item.indirect_tax_amount, currency),
      taxBehavior: behavior,
      engineTaxType: 'VAT',
    });
  }

  return rows;
}

function buildJurisdiction(
  level: string | undefined,
  country: string | undefined,
  name: string | undefined,
): Jurisdiction {
  return {
    type: mapTaxLevel(level),
    code: country ?? 'UNKNOWN',
    country,
    name,
  };
}

function mapTaxLevel(level: string | undefined): JurisdictionType {
  switch ((level ?? '').toLowerCase()) {
    case 'state':
    case 'province':
      return 'state';
    case 'county':
      return 'county';
    case 'city':
    case 'municipal':
      return 'city';
    case 'country':
    case 'federal':
    case 'national':
      return 'country';
    default:
      return 'country'; // VAT is overwhelmingly national
  }
}

function mapTaxName(name: string | undefined): 'vat' | 'additional' {
  const n = (name ?? '').toLowerCase();
  if (/vat|btw|iva|tva|mwst|moms|gst|hst|igst|jct|qst|pst/.test(n)) return 'vat';
  return n ? 'additional' : 'vat'; // unnamed indirect tax defaults to VAT
}
