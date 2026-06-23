import type { TaxInput, JurisdictionType } from '@tax-ledger/core';

type LineTaxType = 'sales' | 'shipping' | 'additional';
import {
  AvalaraTransactionModelSchema,
  type AvalaraTransactionLine,
  type AvalaraTransactionLineDetail,
  type AvalaraJurisdictionType,
  type AvalaraTransactionModel,
} from './schema.js';

/**
 * Options for `toTaxInput`.
 *
 * - `orderId`: stored on the resulting ledger. Defaults to the Avalara
 *   `code` (which is the merchant-supplied transaction code).
 * - `feeRefs`: which Avalara `ref1` values identify fee lines (vs product
 *   lines). Defaults to a common set; override when your shop tags fees
 *   differently.
 * - `quantityByRef`: optional map from `ref1` → integer quantity. Avalara
 *   carries `line.quantity` natively so callers rarely need this — useful
 *   when the engine response was created without explicit quantity.
 * - `depositPredicate`: optional predicate to flag a detail as a deposit
 *   (bottle / container) instead of a tax. Defaults to looking for
 *   `taxType === 'BottleDeposit'` (Avalara emits this for NY-style
 *   container deposits).
 */
export interface AvalaraAdapterOptions {
  orderId?: string;
  feeRefs?: ReadonlySet<string>;
  quantityByRef?: Readonly<Record<string, number>>;
  depositPredicate?: (detail: AvalaraTransactionLineDetail) => boolean;
}

const DEFAULT_FEE_REFS = new Set([
  'shipping',
  'shippingFee',
  'serviceFee',
  'service',
  'tip',
  'checkoutBag',
  'platform',
  'platformFee',
]);

const DEFAULT_DEPOSIT_PREDICATE = (d: AvalaraTransactionLineDetail): boolean =>
  /bottle.?deposit|container.?deposit/i.test(d.taxType);

/**
 * Convert an Avalara `CreateTransactionModel` response into the engine-
 * agnostic `TaxInput`. Money values arrive as decimal dollars; we convert
 * to integer cents via banker-safe rounding.
 *
 * The mapping:
 *   - `tx.code`           → `engineRef`
 *   - `tx.currencyCode`   → `currency` (uppercased)
 *   - `tx.totalTax`       → `totalTaxCents`
 *   - product line.ref1   → `lineItemId` (fallback: `lineNumber`)
 *   - fee line.ref1       → `feeKind`
 *   - line.quantity       → `quantity`
 *   - line.details[]      → per-(jurisdiction, taxType) row, except deposit
 *                           details which are split into the `deposits[]`
 *                           array on the line.
 *
 * Avalara's `jurisdictionType` casing is normalized (Country → country,
 * etc.). Unknown types map to `special`. `taxType` is mapped to the
 * core's small enum: anything that isn't `Sales` / `Shipping` becomes
 * `additional` so the figure stays on the ledger without losing the engine
 * label.
 */
export function toTaxInput(
  response: unknown,
  options: AvalaraAdapterOptions = {},
): TaxInput {
  const tx: AvalaraTransactionModel = AvalaraTransactionModelSchema.parse(response);
  const feeRefs = options.feeRefs ?? DEFAULT_FEE_REFS;
  const depositPredicate = options.depositPredicate ?? DEFAULT_DEPOSIT_PREDICATE;

  const productLines: AvalaraTransactionLine[] = [];
  const feeLines: AvalaraTransactionLine[] = [];
  for (const ln of tx.lines) {
    const ref = ln.ref1 ?? ln.lineNumber;
    if (feeRefs.has(ref)) feeLines.push(ln);
    else productLines.push(ln);
  }

  const taxInputLines = productLines.map((ln) => {
    const lineItemId = ln.ref1 ?? ln.lineNumber;
    const qty =
      options.quantityByRef?.[lineItemId] ??
      Math.max(1, Math.round(ln.quantity));
    const totalCents = toCents(ln.lineAmount);
    const unitAmountCents = Math.max(0, Math.floor(totalCents / qty));

    const taxes: TaxInput['lines'][number]['taxes'] = [];
    const deposits: NonNullable<TaxInput['lines'][number]['deposits']> = [];
    for (const d of ln.details) {
      const jurisdiction = {
        type: mapJurisdictionType(d.jurisdictionType),
        code: d.jurisdictionCode ?? d.jurisName ?? d.region ?? 'UNKNOWN',
      };
      const cents = toCents(d.tax);
      if (cents <= 0) continue;
      if (depositPredicate(d)) {
        deposits.push({ jurisdiction, amountCents: cents });
        continue;
      }
      taxes.push({
        jurisdiction,
        taxType: mapTaxType(d.taxType),
        amountCents: cents,
      });
    }

    return {
      lineItemId,
      quantity: qty,
      unitAmountCents,
      taxes,
      deposits,
    };
  });

  const taxInputFees = feeLines.map((ln) => {
    const feeKind = ln.ref1 ?? ln.lineNumber;
    const taxes = ln.details
      .filter((d) => toCents(d.tax) > 0)
      .map((d) => ({
        jurisdiction: {
          type: mapJurisdictionType(d.jurisdictionType),
          code: d.jurisdictionCode ?? d.jurisName ?? d.region ?? 'UNKNOWN',
        },
        taxType: mapTaxType(d.taxType),
        amountCents: toCents(d.tax),
      }));
    return {
      feeKind: normalizeFeeKind(feeKind),
      amountCents: toCents(ln.lineAmount),
      taxes,
    };
  });

  return {
    orderId: options.orderId ?? tx.code,
    currency: tx.currencyCode.toUpperCase(),
    engineRef: tx.code,
    totalTaxCents: toCents(tx.totalTax),
    lines: taxInputLines,
    fees: taxInputFees,
  };
}

/** Decimal-dollar → integer-cent. Banker-safe (avoid `Math.round` FP cliff). */
function toCents(dollars: number): number {
  // Avoid 1.005 * 100 = 100.49999… by routing through string fixed-point.
  if (!Number.isFinite(dollars)) return 0;
  const scaled = Math.round(dollars * 100 + Number.EPSILON);
  return scaled;
}

function mapJurisdictionType(j: AvalaraJurisdictionType): JurisdictionType {
  switch (j) {
    case 'Country':
      return 'country';
    case 'State':
      return 'state';
    case 'County':
    case 'CountyDistrict':
      return 'county';
    case 'City':
    case 'CityDistrict':
      return 'city';
    case 'Special':
    case 'STA':
    default:
      return 'special';
  }
}

function mapTaxType(t: string): LineTaxType {
  const lc = t.toLowerCase();
  if (lc === 'sales' || lc.includes('sales')) return 'sales';
  if (lc === 'shipping' || lc.includes('shipping') || lc.includes('freight')) return 'shipping';
  return 'additional';
}

function normalizeFeeKind(ref: string): string {
  switch (ref) {
    case 'shippingFee':
    case 'shipping':
      return 'shipping';
    case 'serviceFee':
    case 'service':
      return 'service';
    case 'platformFee':
    case 'platform':
      return 'platform';
    default:
      return ref;
  }
}
