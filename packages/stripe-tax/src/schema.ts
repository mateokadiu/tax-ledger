import { z } from 'zod';

/**
 * Zod schemas for Stripe's `Tax.Calculation` response object.
 *
 * Reference: https://docs.stripe.com/api/tax/calculations/object
 *
 * Money convention: Stripe uses integer minor units (cents) throughout — no
 * decimal conversion needed. Currency is on the calculation root.
 */

export const StripeTaxJurisdictionLevelSchema = z.enum([
  'country',
  'state',
  'county',
  'city',
  'district',
  'special',
]);
export type StripeTaxJurisdictionLevel = z.infer<typeof StripeTaxJurisdictionLevelSchema>;

export const StripeTaxJurisdictionSchema = z
  .object({
    country: z.string().min(2),
    level: StripeTaxJurisdictionLevelSchema,
    display_name: z.string().optional(),
    state: z.string().optional(),
  })
  .passthrough();
export type StripeTaxJurisdiction = z.infer<typeof StripeTaxJurisdictionSchema>;

export const StripeTaxRateDetailsSchema = z
  .object({
    display_name: z.string().optional(),
    percentage_decimal: z.string().optional(),
    tax_type: z.string().optional(),
  })
  .passthrough();
export type StripeTaxRateDetails = z.infer<typeof StripeTaxRateDetailsSchema>;

export const StripeTaxBreakdownSchema = z
  .object({
    amount: z.number().int(),
    inclusive: z.boolean().optional(),
    jurisdiction: StripeTaxJurisdictionSchema,
    sourcing: z.string().optional(),
    tax_rate_details: StripeTaxRateDetailsSchema.optional(),
    taxability_reason: z.string().optional(),
    taxable_amount: z.number().int().optional(),
  })
  .passthrough();
export type StripeTaxBreakdown = z.infer<typeof StripeTaxBreakdownSchema>;

export const StripeLineItemSchema = z
  .object({
    id: z.string().optional(),
    object: z.literal('tax.calculation_line_item').optional(),
    amount: z.number().int(),
    amount_tax: z.number().int(),
    livemode: z.boolean().optional(),
    product: z.string().nullable().optional(),
    quantity: z.number().int().positive(),
    reference: z.string().optional(),
    tax_behavior: z.string().optional(),
    tax_code: z.string().optional(),
    tax_breakdown: z.array(StripeTaxBreakdownSchema).default([]),
  })
  .passthrough();
export type StripeLineItem = z.infer<typeof StripeLineItemSchema>;

export const StripeShippingCostSchema = z
  .object({
    amount: z.number().int(),
    amount_tax: z.number().int(),
    shipping_rate: z.string().nullable().optional(),
    tax_behavior: z.string().optional(),
    tax_code: z.string().optional(),
    tax_breakdown: z.array(StripeTaxBreakdownSchema).default([]),
  })
  .passthrough();
export type StripeShippingCost = z.infer<typeof StripeShippingCostSchema>;

export const StripeTaxCalculationSchema = z
  .object({
    id: z.string().nullable().optional(),
    object: z.literal('tax.calculation').optional(),
    amount_total: z.number().int(),
    currency: z.string().min(3).max(3),
    customer: z.string().nullable().optional(),
    expires_at: z.number().int().optional(),
    livemode: z.boolean().optional(),
    line_items: z
      .object({
        object: z.literal('list').optional(),
        data: z.array(StripeLineItemSchema).min(1),
        has_more: z.boolean().optional(),
        url: z.string().optional(),
      })
      .or(z.array(StripeLineItemSchema).min(1))
      .transform((v) => (Array.isArray(v) ? v : v.data)),
    shipping_cost: StripeShippingCostSchema.nullable().optional(),
    tax_amount_exclusive: z.number().int(),
    tax_amount_inclusive: z.number().int().optional(),
    tax_breakdown: z.array(StripeTaxBreakdownSchema).optional(),
    tax_date: z.number().int().optional(),
  })
  .passthrough();
export type StripeTaxCalculation = z.infer<typeof StripeTaxCalculationSchema>;
