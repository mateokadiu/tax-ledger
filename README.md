# tax-ledger

Line-item tax splitter + reconciliation engine. Sits downstream of Avalara, TaxJar, Stripe Tax. Takes their totals plus your line items and emits a deterministic ledger: per-line, per-jurisdiction, per-tax-type rows that sum back to the engine total to the cent and stay reconciled across refunds, partial captures, and revisions.

**Status:** v0.1 — `@tax-ledger/core` shipped (pure splitter + reconciler). Adapters, Postgres, NestJS, and CLI deferred to v0.2+.

## Why

Every team that touches sales tax in production ends up with the same 1,000-line ratio-and-`Math.floor` blob smeared across their refund flow. After three partial refunds the books drift a few cents. After a thousand orders, a few dollars. Accountants get involved.

This is the pure-math piece factored out: a 200-line function with property-based tests proving the books always reconcile.

## Install

```bash
pnpm add @tax-ledger/core
```

## Usage

```ts
import { split, refund } from '@tax-ledger/core';

const ledger = split({
  orderId: 'order_123',
  currency: 'USD',
  engineRef: 'avalara_tx_001',
  totalTaxCents: 412,
  lines: [
    {
      lineItemId: 'A', quantity: 2, unitAmountCents: 2499,
      taxes: [
        { jurisdiction: { type: 'state',  code: 'NY' }, taxType: 'sales', amountCents: 150 },
        { jurisdiction: { type: 'county', code: 'NY-NYC' }, taxType: 'sales', amountCents: 45 },
        { jurisdiction: { type: 'city',   code: 'NY-NYC' }, taxType: 'sales', amountCents: 36 },
      ],
      deposits: [
        { jurisdiction: { type: 'state', code: 'NY' }, amountCents: 1000 },
      ],
    },
    // ... line B, line C
  ],
  fees: [{ feeKind: 'shipping', amountCents: 652, taxes: [/*...*/] }],
});

const delta = refund(ledger, {
  refundId: 'rf_001',
  lines: [{ lineItemId: 'A', quantity: 1 }],
});

const live = ledger.with(delta);
// sum(live.rows) == ledger total minus refund total, to the cent
```

## Status, v0.1 scope

Shipped:
- `@tax-ledger/core` — pure splitter + reconciler. Decimal.js arbitrary-precision math, largest-remainder allocation, integer-cent output.
- Property-based test suite (fast-check) — sum-equals-total, refund-sums-back, idempotent reconcile, no-fractional-cents.

Deferred to v0.2+:
- `@tax-ledger/sources-avalara`, `-taxjar`, `-stripe-tax` — engine adapters.
- `@tax-ledger/postgres` — Drizzle schema + repository.
- `@tax-ledger/nestjs` — `TaxLedgerModule` for DI.
- `@tax-ledger/cli` — `reconcile`, `audit`.

See [`PLAN.md`](./PLAN.md) for the full architecture and roadmap.

## Contributing

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## License

MIT.
