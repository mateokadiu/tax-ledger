/**
 * End-to-end demo of @tax-ledger/core against an Avalara-shaped input.
 *
 * Run with: pnpm --filter @tax-ledger/example-basic start
 *
 * Walkthrough:
 *   1. Load a mock Avalara response from JSON.
 *   2. Map it into the engine-agnostic OrderInput shape (this is what
 *      `@tax-ledger/sources-avalara` will do in v0.2 — for now we inline it).
 *   3. split() it to a Ledger.
 *   4. refund() one beer (line A, half quantity by amountCents).
 *   5. Print the live ledger's per-jurisdiction net.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { split, refund, type OrderInput } from '@tax-ledger/core';

const HERE = dirname(fileURLToPath(import.meta.url));

interface AvalaraDetail {
  jurisdictionType: string;
  jurisdictionCode: string;
  taxType: string;
  tax: number;
}
interface AvalaraDeposit {
  jurisdictionType: string;
  jurisdictionCode: string;
  amount: number;
}
interface AvalaraLine {
  lineNumber: string;
  ref1: string;
  lineAmount: number;
  tax: number;
  details?: AvalaraDetail[];
  extraDeposits?: AvalaraDeposit[];
}
interface AvalaraResponse {
  code: string;
  totalTax: number;
  totalAmount: number;
  lines: AvalaraLine[];
}

const dollarsToCents = (d: number) => Math.round(d * 100);

function mapJurisdictionType(t: string): 'state' | 'county' | 'city' | 'country' | 'special' {
  switch (t.toLowerCase()) {
    case 'state':
      return 'state';
    case 'county':
      return 'county';
    case 'city':
      return 'city';
    case 'country':
      return 'country';
    default:
      return 'special';
  }
}

function mapTaxType(t: string): 'sales' | 'shipping' | 'additional' {
  switch (t.toLowerCase()) {
    case 'sales':
      return 'sales';
    case 'shipping':
      return 'shipping';
    default:
      return 'additional';
  }
}

const QTY_BY_REF: Record<string, number> = {
  A: 2,
  B: 1,
};

function toOrderInput(av: AvalaraResponse, orderId: string): OrderInput {
  // ref1 = lineItemId for product lines; fee lines are detected by ref1.
  const FEE_REF = new Set(['shippingFee', 'serviceFee', 'tip', 'checkoutBag']);
  const lines = av.lines.filter((l) => !FEE_REF.has(l.ref1));
  const fees = av.lines.filter((l) => FEE_REF.has(l.ref1));

  return {
    orderId,
    currency: 'USD',
    engineRef: av.code,
    totalTaxCents: dollarsToCents(av.totalTax),
    lines: lines.map((l) => {
      // In a real adapter, quantity comes from the caller's order context;
      // here we pull it from a side table for demo purposes.
      const qty = QTY_BY_REF[l.ref1] ?? 1;
      const totalCents = dollarsToCents(l.lineAmount);
      // floor + spread the remainder cents into the unit price for the mock —
      // a real adapter would receive (qty, unitAmountCents) directly.
      return {
      lineItemId: l.ref1,
      quantity: qty,
      unitAmountCents: Math.floor(totalCents / qty),
      taxes: (l.details ?? []).map((d) => ({
        jurisdiction: { type: mapJurisdictionType(d.jurisdictionType), code: d.jurisdictionCode },
        taxType: mapTaxType(d.taxType),
        amountCents: dollarsToCents(d.tax),
      })),
      deposits: (l.extraDeposits ?? []).map((d) => ({
        jurisdiction: { type: mapJurisdictionType(d.jurisdictionType) as 'state' | 'country', code: d.jurisdictionCode },
        amountCents: dollarsToCents(d.amount),
      })),
    }; }),
    fees: fees.map((f) => ({
      feeKind: f.ref1 === 'shippingFee' ? 'shipping' : f.ref1,
      amountCents: dollarsToCents(f.lineAmount),
      taxes: (f.details ?? []).map((d) => ({
        jurisdiction: { type: mapJurisdictionType(d.jurisdictionType), code: d.jurisdictionCode },
        taxType: mapTaxType(d.taxType),
        amountCents: dollarsToCents(d.tax),
      })),
    })),
  };
}

const av = JSON.parse(readFileSync(join(HERE, 'avalara-response.json'), 'utf8')) as AvalaraResponse;
const input = toOrderInput(av, 'order_demo_001');

console.log('--- 1) Avalara → OrderInput');
console.log(`  orderId: ${input.orderId}, engineRef: ${input.engineRef}`);
console.log(`  totalTaxCents: ${input.totalTaxCents}, lines: ${input.lines.length}, fees: ${input.fees?.length ?? 0}`);

const ledger = split(input);
console.log('\n--- 2) split() → Ledger');
console.log(`  rows: ${ledger.rows.length}`);
for (const r of ledger.rows) {
  const scopeLabel =
    r.scope.kind === 'line' ? `line:${r.scope.lineItemId}`
    : r.scope.kind === 'fee' ? `fee:${r.scope.feeKind}`
    : `order:${r.scope.reason}`;
  console.log(`    ${scopeLabel}  ${r.jurisdiction.type}:${r.jurisdiction.code}  ${r.taxType}  ${r.amountCents}c`);
}

const lineA_net = ledger.netCents({ lineItemId: 'A' });
const refundAmt = Math.floor(lineA_net / 2); // refund half the line by value
console.log(`\n--- 3) refund line A by ${refundAmt}c (half of its ${lineA_net}c net)`);
const delta = refund(ledger, {
  refundId: 'rf_demo_001',
  lines: [{ lineItemId: 'A', amountCents: refundAmt }],
});

for (const r of delta) {
  console.log(`    DELTA ${r.jurisdiction.type}:${r.jurisdiction.code}  ${r.taxType}  ${r.amountCents}c`);
}
console.log(`  sum(delta) = ${delta.reduce((a, r) => a + r.amountCents, 0)}c`);

const live = ledger.with(delta);
console.log('\n--- 4) live ledger after refund');
console.log(`  sales tax:    ${live.netCents({ taxType: 'sales' })}c`);
console.log(`  shipping tax: ${live.netCents({ taxType: 'shipping' })}c`);
console.log(`  additional:   ${live.netCents({ taxType: 'additional' })}c`);
console.log(`  deposit:      ${live.netCents({ taxType: 'bottle_deposit' })}c`);
console.log(`  total:        ${live.rows.reduce((a, r) => a + r.amountCents, 0)}c`);
console.log('  (= original total - refunded total, to the cent.)');
