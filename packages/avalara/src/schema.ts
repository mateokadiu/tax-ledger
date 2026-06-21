import { z } from 'zod';

/**
 * Zod schemas mirroring the subset of Avalara's `TransactionModel` response
 * (returned by `CreateTransactionModel` / `GetTransactionByCode`) that the
 * adapter actually consumes.
 *
 * Avalara's response is large and inconsistent across SDK versions. We pin
 * only the fields we need and pass through unknowns via `passthrough()` so
 * future engine fields don't break callers.
 *
 * Reference: https://developer.avalara.com/api-reference/avatax/rest/v2/methods/Transactions/CreateTransaction/
 *
 * Money convention: Avalara emits decimals as numbers (USD dollars at scale
 * 2). Adapters convert to integer cents at the boundary.
 */

export const AvalaraJurisdictionTypeSchema = z.enum([
  'Country',
  'State',
  'County',
  'City',
  'Special',
  'CountyDistrict',
  'CityDistrict',
  'STA',
]);
export type AvalaraJurisdictionType = z.infer<typeof AvalaraJurisdictionTypeSchema>;

/**
 * One per-jurisdiction tax detail. Avalara emits one `details[]` entry per
 * (jurisdiction, taxType) for every line. The amount we care about is
 * `tax` (or `taxCalculated` — they match in non-exempt cases).
 */
export const AvalaraTransactionLineDetailSchema = z
  .object({
    id: z.number().optional(),
    transactionLineId: z.number().optional(),
    jurisdictionId: z.number().optional(),
    jurisdictionType: AvalaraJurisdictionTypeSchema,
    jurisdictionCode: z.string().min(1).optional(),
    jurisName: z.string().optional(),
    stateAssignedNo: z.string().optional(),
    taxType: z.string().min(1),
    taxSubTypeId: z.string().optional(),
    taxName: z.string().optional(),
    rateTypeCode: z.string().optional(),
    taxAuthorityTypeId: z.number().optional(),
    rate: z.number().optional(),
    tax: z.number(),
    taxableAmount: z.number().optional(),
    taxCalculated: z.number().optional(),
    nonTaxableAmount: z.number().optional(),
    exemptAmount: z.number().optional(),
    exemptReasonId: z.number().optional(),
    isFee: z.boolean().optional(),
    region: z.string().optional(),
    country: z.string().optional(),
  })
  .passthrough();
export type AvalaraTransactionLineDetail = z.infer<typeof AvalaraTransactionLineDetailSchema>;

/**
 * A single line on the Avalara transaction. `ref1` is the merchant-supplied
 * external identifier — by convention the adapter uses it as the
 * `lineItemId`. `itemCode` is the SKU fallback.
 */
export const AvalaraTransactionLineSchema = z
  .object({
    id: z.number().optional(),
    transactionId: z.number().optional(),
    lineNumber: z.string().min(1),
    description: z.string().optional(),
    itemCode: z.string().optional(),
    ref1: z.string().optional(),
    ref2: z.string().optional(),
    quantity: z.number().positive(),
    lineAmount: z.number(),
    discountAmount: z.number().optional(),
    taxableAmount: z.number().optional(),
    exemptAmount: z.number().optional(),
    tax: z.number(),
    taxCalculated: z.number().optional(),
    taxCode: z.string().optional(),
    taxIncluded: z.boolean().optional(),
    isItemTaxable: z.boolean().optional(),
    details: z.array(AvalaraTransactionLineDetailSchema).default([]),
  })
  .passthrough();
export type AvalaraTransactionLine = z.infer<typeof AvalaraTransactionLineSchema>;

/**
 * Subset of the top-level Avalara `TransactionModel`. We treat the response
 * as plain JSON — no SDK dependency — to keep the adapter footprint small.
 */
export const AvalaraTransactionModelSchema = z
  .object({
    id: z.number().optional(),
    code: z.string().min(1),
    companyId: z.number().optional(),
    date: z.string().optional(),
    type: z.string().optional(),
    status: z.string().optional(),
    currencyCode: z.string().min(3).max(3),
    customerCode: z.string().optional(),
    salespersonCode: z.string().optional(),
    customerUsageType: z.string().optional(),
    entityUseCode: z.string().optional(),
    totalAmount: z.number(),
    totalExempt: z.number().optional(),
    totalDiscount: z.number().optional(),
    totalTax: z.number(),
    totalTaxable: z.number().optional(),
    totalTaxCalculated: z.number().optional(),
    locked: z.boolean().optional(),
    region: z.string().optional(),
    country: z.string().optional(),
    version: z.number().optional(),
    lines: z.array(AvalaraTransactionLineSchema).min(1),
  })
  .passthrough();
export type AvalaraTransactionModel = z.infer<typeof AvalaraTransactionModelSchema>;
