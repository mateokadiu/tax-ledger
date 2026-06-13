import { z } from 'zod';

/**
 * Stripe Tax reversal bridge.
 *
 * Stripe is the source of truth for refunded tax: you record a refund by
 * creating a *reversal* transaction (`stripe.tax.transactions.createReversal`),
 * not by prorating stored values locally. This module is the two ends of that
 * workflow:
 *
 *   1. `toStripeReversal()` — build the `create_reversal` params (full, flat,
 *      or per-line). All reversal amounts are negative cents, per the API.
 *   2. `reversalTotals()` — read the reversed amounts back off the returned
 *      transaction. Feed `taxCents` to core `reconcile(ledger, delta,
 *      { expectTotalCents })` to prove your local ledger agrees with Stripe.
 *
 * Reference: https://docs.stripe.com/api/tax/transactions/create_reversal
 */

// ---------- build create_reversal params ----------

export interface StripeReversalLineInput {
  /** Stripe original line-item id from the source transaction (`tax_li_…`). */
  originalLineItem: string;
  /** Net (ex-tax) amount to reverse, positive cents — negated in the output. */
  amountCents: number;
  /** Tax to reverse, positive cents — negated in the output. */
  amountTaxCents: number;
  /** Optional per-line reference recorded on the reversal. */
  reference?: string;
}

export type StripeReversalInput =
  | { mode: 'full'; originalTransaction: string; reference: string }
  | { mode: 'partial'; originalTransaction: string; reference: string; flatAmountCents: number }
  | { mode: 'partial'; originalTransaction: string; reference: string; lineItems: StripeReversalLineInput[] };

export interface StripeReversalParams {
  mode: 'full' | 'partial';
  original_transaction: string;
  reference: string;
  flat_amount?: number;
  line_items?: Array<{ amount: number; amount_tax: number; original_line_item: string; reference?: string }>;
}

/**
 * Build the params object for `stripe.tax.transactions.createReversal(...)`.
 *
 *   - full:    reverse the entire original transaction.
 *   - flat:    reverse a single `flat_amount` (total incl. tax) across the txn —
 *              the shape AccelPay uses for amount-based partial refunds.
 *   - lines:   reverse specific original line items by id.
 *
 * `reference` must be unique across all your transactions (Stripe enforces it).
 */
export function toStripeReversal(input: StripeReversalInput): StripeReversalParams {
  if (input.mode === 'full') {
    return { mode: 'full', original_transaction: input.originalTransaction, reference: input.reference };
  }
  if ('flatAmountCents' in input) {
    return {
      mode: 'partial',
      original_transaction: input.originalTransaction,
      reference: input.reference,
      flat_amount: -Math.abs(input.flatAmountCents),
    };
  }
  return {
    mode: 'partial',
    original_transaction: input.originalTransaction,
    reference: input.reference,
    line_items: input.lineItems.map((l) => ({
      amount: -Math.abs(l.amountCents),
      amount_tax: -Math.abs(l.amountTaxCents),
      original_line_item: l.originalLineItem,
      ...(l.reference ? { reference: l.reference } : {}),
    })),
  };
}

// ---------- read a reversal transaction response ----------

const ReversalLineSchema = z
  .object({ amount: z.number().int(), amount_tax: z.number().int() })
  .passthrough();

const ReversalTransactionSchema = z
  .object({
    object: z.literal('tax.transaction').optional(),
    mode: z.string().optional(),
    reference: z.string().optional(),
    line_items: z
      .object({ data: z.array(ReversalLineSchema) })
      .or(z.array(ReversalLineSchema))
      .transform((v) => (Array.isArray(v) ? v : v.data))
      .optional(),
    shipping_cost: z
      .object({ amount: z.number().int(), amount_tax: z.number().int() })
      .nullable()
      .optional(),
  })
  .passthrough();

export interface ReversalTotals {
  /** Tax reversed, in cents (negative for a refund). */
  taxCents: number;
  /** Net (ex-tax) amount reversed, in cents (negative). */
  netCents: number;
  /** `netCents + taxCents` (negative). */
  totalCents: number;
}

/**
 * Sum the reversed amounts off a Stripe Tax reversal `Transaction`. Use
 * `taxCents` as `expectTotalCents` for core `reconcile()` — it's the
 * authoritative tax Stripe actually reversed, which your local refund delta
 * should match to the cent.
 */
export function reversalTotals(reversal: unknown): ReversalTotals {
  const parsed = ReversalTransactionSchema.parse(reversal);
  let taxCents = 0;
  let netCents = 0;
  for (const li of parsed.line_items ?? []) {
    netCents += li.amount;
    taxCents += li.amount_tax;
  }
  if (parsed.shipping_cost) {
    netCents += parsed.shipping_cost.amount;
    taxCents += parsed.shipping_cost.amount_tax;
  }
  return { taxCents, netCents, totalCents: netCents + taxCents };
}
