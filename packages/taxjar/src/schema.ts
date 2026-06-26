import { z } from 'zod';

/**
 * Zod schemas for TaxJar's `POST /v2/taxes` response. TaxJar emits a single
 * `tax` envelope with one `breakdown` per jurisdiction *plus* per-line
 * `breakdown.line_items[]` entries with per-jurisdiction sub-amounts.
 *
 * Reference: https://developers.taxjar.com/api/reference/#post-calculate-sales-tax-for-an-order
 *
 * Money convention: TaxJar emits decimal numbers (currency major units).
 */

export const TaxJarLineItemJurisdictionBreakdownSchema = z
  .object({
    state_amount: z.number().optional(),
    state_sales_tax_rate: z.number().optional(),
    state_taxable_amount: z.number().optional(),
    county_amount: z.number().optional(),
    county_tax_rate: z.number().optional(),
    county_taxable_amount: z.number().optional(),
    city_amount: z.number().optional(),
    city_tax_rate: z.number().optional(),
    city_taxable_amount: z.number().optional(),
    special_district_amount: z.number().optional(),
    special_tax_rate: z.number().optional(),
    special_district_taxable_amount: z.number().optional(),
    combined_tax_rate: z.number().optional(),
    tax_collectable: z.number().optional(),
    taxable_amount: z.number().optional(),
  })
  .passthrough();
export type TaxJarLineItemJurisdictionBreakdown = z.infer<
  typeof TaxJarLineItemJurisdictionBreakdownSchema
>;

export const TaxJarLineItemBreakdownSchema = TaxJarLineItemJurisdictionBreakdownSchema.extend({
  id: z.string().min(1),
});
export type TaxJarLineItemBreakdown = z.infer<typeof TaxJarLineItemBreakdownSchema>;

export const TaxJarShippingBreakdownSchema = z
  .object({
    state_amount: z.number().optional(),
    state_sales_tax_rate: z.number().optional(),
    state_taxable_amount: z.number().optional(),
    county_amount: z.number().optional(),
    county_tax_rate: z.number().optional(),
    county_taxable_amount: z.number().optional(),
    city_amount: z.number().optional(),
    city_tax_rate: z.number().optional(),
    city_taxable_amount: z.number().optional(),
    special_district_amount: z.number().optional(),
    special_tax_rate: z.number().optional(),
    special_district_taxable_amount: z.number().optional(),
    combined_tax_rate: z.number().optional(),
    tax_collectable: z.number().optional(),
    taxable_amount: z.number().optional(),
  })
  .passthrough();
export type TaxJarShippingBreakdown = z.infer<typeof TaxJarShippingBreakdownSchema>;

export const TaxJarBreakdownSchema = z
  .object({
    taxable_amount: z.number().optional(),
    tax_collectable: z.number().optional(),
    combined_tax_rate: z.number().optional(),
    state_taxable_amount: z.number().optional(),
    state_tax_rate: z.number().optional(),
    state_tax_collectable: z.number().optional(),
    county_taxable_amount: z.number().optional(),
    county_tax_rate: z.number().optional(),
    county_tax_collectable: z.number().optional(),
    city_taxable_amount: z.number().optional(),
    city_tax_rate: z.number().optional(),
    city_tax_collectable: z.number().optional(),
    special_district_taxable_amount: z.number().optional(),
    special_tax_rate: z.number().optional(),
    special_district_tax_collectable: z.number().optional(),
    line_items: z.array(TaxJarLineItemBreakdownSchema).default([]),
    shipping: TaxJarShippingBreakdownSchema.optional(),
  })
  .passthrough();
export type TaxJarBreakdown = z.infer<typeof TaxJarBreakdownSchema>;

export const TaxJarTaxSchema = z
  .object({
    order_total_amount: z.number(),
    shipping: z.number().default(0),
    taxable_amount: z.number().optional(),
    amount_to_collect: z.number(),
    rate: z.number().optional(),
    has_nexus: z.boolean().optional(),
    freight_taxable: z.boolean().optional(),
    tax_source: z.string().optional(),
    exemption_type: z.string().optional(),
    jurisdictions: z
      .object({
        country: z.string().optional(),
        state: z.string().optional(),
        county: z.string().optional(),
        city: z.string().optional(),
      })
      .passthrough()
      .optional(),
    breakdown: TaxJarBreakdownSchema.optional(),
  })
  .passthrough();
export type TaxJarTax = z.infer<typeof TaxJarTaxSchema>;

export const TaxJarTaxResponseSchema = z.object({ tax: TaxJarTaxSchema });
export type TaxJarTaxResponse = z.infer<typeof TaxJarTaxResponseSchema>;
