import { z } from 'zod';

// ---------- Currency ----------

/**
 * ISO-4217 currency code. We don't enumerate the full list — the world
 * mints new currencies, and old engines emit unusual ones (XAU, XDR). We
 * only enforce shape: three uppercase ASCII letters. Adapters are expected
 * to normalize lowercase or whitespace before calling in.
 */
export const CurrencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'currency must be ISO-4217 (three uppercase letters)');
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

// ---------- Jurisdiction ----------

export const JurisdictionTypeSchema = z.enum(['country', 'state', 'county', 'city', 'special']);
export type JurisdictionType = z.infer<typeof JurisdictionTypeSchema>;

export const JurisdictionSchema = z.object({
  type: JurisdictionTypeSchema,
  code: z.string().min(1),
  /** ISO 3166-1 alpha-2 country, when the engine provides it. */
  country: z.string().optional(),
  /** State / province / region label, when distinct from `code`. */
  region: z.string().optional(),
  /** Human-readable jurisdiction name (e.g. "NEW YORK CITY"). */
  name: z.string().optional(),
});
export type Jurisdiction = z.infer<typeof JurisdictionSchema>;

// ---------- Tax types ----------

export const TaxTypeSchema = z.enum(['sales', 'shipping', 'bottle_deposit', 'vat', 'additional']);
export type TaxType = z.infer<typeof TaxTypeSchema>;

/** Whether tax was quoted inside the line amount (inclusive) or added on top (exclusive). */
export const TaxBehaviorSchema = z.enum(['inclusive', 'exclusive']);
export type TaxBehavior = z.infer<typeof TaxBehaviorSchema>;

// ---------- Input ----------

/**
 * One per-jurisdiction tax detail emitted by the tax engine. amountCents is the
 * engine's already-computed cents — the splitter does not recompute rates.
 */
export const LineItemTaxSchema = z.object({
  jurisdiction: JurisdictionSchema,
  taxType: z.enum(['sales', 'shipping', 'vat', 'additional']),
  amountCents: z.number().int().nonnegative(),
  /** Engine product tax-category code (e.g. Avalara `PA2020200`, Stripe `txcd_…`). Carried verbatim for reconciliation. */
  taxCode: z.string().min(1).optional(),
  /** Whether the engine quoted this tax inclusive of or exclusive to the line amount. */
  taxBehavior: TaxBehaviorSchema.optional(),
  /** The engine's native tax-type label (e.g. Avalara `Sales`/`Bottle`, Stripe `vat`/`gst`). Preserved for audit. */
  engineTaxType: z.string().min(1).optional(),
});
export type LineItemTax = z.infer<typeof LineItemTaxSchema>;

/** Bottle / container deposit. Sits alongside taxes — same row shape downstream. */
export const LineItemDepositSchema = z.object({
  jurisdiction: JurisdictionSchema,
  amountCents: z.number().int().nonnegative(),
});
export type LineItemDeposit = z.infer<typeof LineItemDepositSchema>;

export const LineItemSchema = z.object({
  lineItemId: z.string().min(1),
  quantity: z.number().int().positive(),
  unitAmountCents: z.number().int().nonnegative(),
  taxes: z.array(LineItemTaxSchema),
  deposits: z.array(LineItemDepositSchema).default([]),
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const FeeSchema = z.object({
  feeKind: z.string().min(1), // shipping | service | platform | tip | bag | retail_delivery | ...
  amountCents: z.number().int().nonnegative(),
  taxes: z.array(LineItemTaxSchema).default([]),
});
export type Fee = z.infer<typeof FeeSchema>;

/**
 * The engine-agnostic input. Whatever you got from Avalara / TaxJar / Stripe Tax,
 * you map into this shape (an adapter package will do it for you in v0.2).
 *
 * `totalTaxCents` is the engine's declared total tax. We assert against the sum
 * of every line/fee tax detail and fail loudly if they disagree by more than the
 * configured rounding tolerance.
 */
/**
 * Address-pair context for multi-jurisdiction orders. Most engines emit one
 * row per (jurisdiction, taxType) on each line already — the splitter does
 * not infer jurisdictions, just preserves them. ShippingContext is informational
 * (carried on the ledger via row.jurisdiction) and used by adapters to label
 * jurisdictions correctly.
 */
export const ShippingContextSchema = z
  .object({
    shipFrom: JurisdictionSchema.optional(),
    shipTo: JurisdictionSchema.optional(),
    transit: z.array(JurisdictionSchema).default([]),
  })
  .optional();
export type ShippingContext = z.infer<typeof ShippingContextSchema>;

export const OrderInputSchema = z.object({
  orderId: z.string().min(1),
  currency: CurrencyCodeSchema,
  engineRef: z.string().min(1),
  totalTaxCents: z.number().int().nonnegative(),
  shipping: ShippingContextSchema,
  lines: z.array(LineItemSchema).min(1),
  fees: z.array(FeeSchema).default([]),
});
export type OrderInput = z.input<typeof OrderInputSchema>;
export type OrderInputParsed = z.output<typeof OrderInputSchema>;

/**
 * Canonical engine-agnostic input. `OrderInput` is kept as an alias for v0.1
 * compatibility — `TaxInput` is the name adapters and downstream code should
 * use going forward.
 */
export const TaxInputSchema = OrderInputSchema;
export type TaxInput = OrderInput;
export type TaxInputParsed = OrderInputParsed;

// ---------- Output: LedgerEntry ----------

export const LedgerScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('line'), lineItemId: z.string().min(1) }),
  z.object({ kind: z.literal('fee'), feeKind: z.string().min(1) }),
  z.object({ kind: z.literal('order'), reason: z.literal('rounding_residual') }),
]);
export type LedgerScope = z.infer<typeof LedgerScopeSchema>;

export const LedgerOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('split'), engineRef: z.string().min(1) }),
  z.object({ kind: z.literal('refund'), refundId: z.string().min(1) }),
  z.object({ kind: z.literal('capture'), captureId: z.string().min(1) }),
  z.object({ kind: z.literal('revision'), revisionId: z.string().min(1) }),
]);
export type LedgerOrigin = z.infer<typeof LedgerOriginSchema>;

export const LedgerEntrySchema = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  currency: CurrencyCodeSchema,
  scope: LedgerScopeSchema,
  jurisdiction: JurisdictionSchema,
  taxType: TaxTypeSchema,
  amountCents: z.number().int(), // signed: deltas are negative
  /** Engine product tax-category code, carried from the source tax detail. */
  taxCode: z.string().min(1).optional(),
  /** Inclusive vs exclusive, carried from the source tax detail. */
  taxBehavior: TaxBehaviorSchema.optional(),
  /** The engine's native tax-type label, carried from the source tax detail. */
  engineTaxType: z.string().min(1).optional(),
  /** Original line quantity (set on split-origin line rows; enables quantity-based refunds). */
  quantity: z.number().int().positive().optional(),
  origin: LedgerOriginSchema,
  createdAt: z.string().min(1), // ISO-8601
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

// ---------- Specs (refund / capture / revise) ----------

export const RefundLineSchema = z
  .object({
    lineItemId: z.string().min(1),
    quantity: z.number().int().positive().optional(),
    amountCents: z.number().int().positive().optional(),
  })
  .refine((s) => s.quantity != null || s.amountCents != null, {
    message: 'RefundLine requires either quantity or amountCents',
  });
export type RefundLine = z.infer<typeof RefundLineSchema>;

export const RefundFeeSchema = z.object({
  feeKind: z.string().min(1),
  amountCents: z.number().int().positive().optional(), // omitted = full refund
});
export type RefundFee = z.infer<typeof RefundFeeSchema>;

export const RefundSpecSchema = z
  .object({
    refundId: z.string().min(1),
    lines: z.array(RefundLineSchema).default([]),
    fees: z.array(RefundFeeSchema).default([]),
    reason: z.string().optional(),
  })
  .refine((s) => s.lines.length > 0 || s.fees.length > 0, {
    message: 'RefundSpec must refund at least one line or fee',
  });
export type RefundSpec = z.input<typeof RefundSpecSchema>;
export type RefundSpecParsed = z.output<typeof RefundSpecSchema>;

export const CaptureSpecSchema = z.object({
  captureId: z.string().min(1),
  capturedAmountCents: z.number().int().nonnegative(),
  originalAmountCents: z.number().int().positive(),
});
export type CaptureSpec = z.infer<typeof CaptureSpecSchema>;

export const ReviseSpecSchema = z.object({
  revisionId: z.string().min(1),
  newOrder: OrderInputSchema,
});
export type ReviseSpec = z.input<typeof ReviseSpecSchema>;
