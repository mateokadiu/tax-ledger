import { z } from 'zod';

/**
 * Zod schemas for Fonoa's Tax calculation response
 * (`POST https://api.fonoa.com/tax/v2/calculations`).
 *
 * Reference: https://docs.fonoa.com/reference/request-a-calculation
 *
 * Money convention: Fonoa emits decimal amounts in major currency units (e.g.
 * 21.00 EUR), not minor units — the adapter converts to integer minor units at
 * the boundary using the caller-supplied currency. We pin only the fields the
 * adapter reads and `passthrough()` the rest so unknown fields don't break.
 */

export const FonoaTaxBreakdownSchema = z
  .object({
    country: z.string().optional(),
    country_name: z.string().optional(),
    name: z.string().optional(), // local tax name, e.g. "BTW" (NL VAT)
    rate_class: z.string().optional(),
    tax_level: z.string().optional(),
    rate: z.number().optional(),
    amount: z.number(),
  })
  .passthrough();
export type FonoaTaxBreakdown = z.infer<typeof FonoaTaxBreakdownSchema>;

export const FonoaItemResultSchema = z
  .object({
    id: z.string().min(1),
    gross_amount: z.number().optional(),
    net_amount: z.number().optional(),
    indirect_tax_amount: z.number(),
    effective_indirect_tax_rate: z.number().optional(),
    tax_breakdown: z.array(FonoaTaxBreakdownSchema).default([]),
  })
  .passthrough();
export type FonoaItemResult = z.infer<typeof FonoaItemResultSchema>;

export const FonoaResultSchema = z
  .object({
    total_gross: z.number().optional(),
    total_net: z.number().optional(),
    total_indirect_tax_amount: z.number(),
    items: z.array(FonoaItemResultSchema).min(1),
  })
  .passthrough();
export type FonoaResult = z.infer<typeof FonoaResultSchema>;

export const FonoaCalculationSchema = z
  .object({
    id: z.string().min(1),
    result: FonoaResultSchema,
  })
  .passthrough();
export type FonoaCalculation = z.infer<typeof FonoaCalculationSchema>;
