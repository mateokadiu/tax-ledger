# tax-ledger

Line-item tax splitter + reconciliation engine. Sits downstream of Avalara, TaxJar, Stripe Tax. Takes their per-jurisdiction totals plus your line items and emits a deterministic ledger: per-line, per-jurisdiction, per-tax-type rows that sum back to the engine's total to the cent and stay reconciled across refunds, partial captures, and revisions.

```
                  Avalara / TaxJar / Stripe Tax
                              │
                              ▼
                       OrderInput
                              │
                              ▼
                   ┌──────────────────┐
                   │ @tax-ledger/core │
                   │                  │
                   │  split()         │ ─► Ledger (rows[])
                   │  refund()        │
                   │  partialCapture()│ ─► delta entries
                   │  revise()        │
                   │                  │
                   │  largest-rem.    │
                   │  allocator       │
                   │  (Decimal.js)    │
                   └──────────────────┘
                              │
                              ▼
                         your books
```

MIT, public from day one. v0.1 ships `@tax-ledger/core` — the pure splitter + reconciler. Engine adapters, Postgres, NestJS, and CLI are deferred to v0.2+ (see below).

## Why it exists

Every team that ships sales tax in production ends up with the same 1,000-line ratio-and-`Math.floor` blob smeared across their refund flow. After three partial refunds the books drift a few cents. After a thousand orders, a few dollars. Accountants get involved.

`@tax-ledger/core` is that 1,000 lines factored out into a ~600-line pure function with property-based tests proving the books always reconcile. The math:

- **Largest-remainder (Hamilton's method)** allocation, not ratio truncation. The sum of allocated integer cents equals the input cents exactly.
- **Decimal.js** for the intermediate math. No FP drift, no `Math.floor(ratio * tax)` cliff.
- **Append-only ledger.** Refunds, captures, and revisions emit delta entries — they don't mutate prior rows. Replay is a fold.

## Install

```bash
pnpm add @tax-ledger/core
```

Requires Node 20+.

## Quick start

```ts
import { split, refund, partialCapture, revise } from '@tax-ledger/core';

// 1) Split an engine response into a ledger
const ledger = split({
  orderId: 'order_123',
  currency: 'USD',
  engineRef: 'avalara_tx_001',
  totalTaxCents: 412,
  lines: [
    {
      lineItemId: 'A', quantity: 2, unitAmountCents: 2499,
      taxes: [
        { jurisdiction: { type: 'state', code: 'NY' },     taxType: 'sales', amountCents: 150 },
        { jurisdiction: { type: 'county', code: 'NY-NYC' }, taxType: 'sales', amountCents: 45 },
        { jurisdiction: { type: 'city', code: 'NY-NYC' },  taxType: 'sales', amountCents: 36 },
      ],
      deposits: [{ jurisdiction: { type: 'state', code: 'NY' }, amountCents: 1000 }],
    },
    // ... lines B, C ...
  ],
  fees: [
    {
      feeKind: 'shipping',
      amountCents: 652,
      taxes: [{ jurisdiction: { type: 'state', code: 'NY' }, taxType: 'shipping', amountCents: 3 }],
    },
  ],
});
// ledger.rows is 8 rows; sum(taxes) === 412, sum(deposits) === 1000.

// 2) Refund half of line A
const delta = refund(ledger, {
  refundId: 'rf_001',
  lines: [{ lineItemId: 'A', amountCents: 615 }],
});
// 4 delta rows summing to -615 cents — allocated by largest-remainder.

const live = ledger.with(delta);
// live.netCents({ taxType: 'sales' }) === 294
```

Run the full demo end-to-end:

```bash
pnpm install
pnpm --filter @tax-ledger/example-basic start
```

See [`examples/basic/`](./examples/basic/) for the source — Avalara JSON in, ledger printed out.

## Worked example: bottle-deposit refund

A NY beer order: 2 units of line A @ \$24.99 with \$5/unit bottle deposit. The engine returns the per-jurisdiction sales tax breakdown (\$1.50 state, \$0.45 county, \$0.36 city) plus the \$10 deposit on the side.

```
split() ──►  8 ledger rows:
              line:A  state:NY    sales            150c
              line:A  county:NY-NYC sales           45c
              line:A  city:NY-NYC   sales           36c
              line:A  state:NY    bottle_deposit  1000c
              line:B  state:NY    sales           120c
              line:B  county:NY-NYC sales           36c
              line:B  city:NY-NYC   sales           22c
              fee:shipping state:NY shipping         3c
```

You refund one of the two beers (half of line A). The reconciler doesn't ask the engine to recompute — it works on the ledger:

```
refund(ledger, { refundId: 'rf_001', lines: [{ lineItemId: 'A', amountCents: 615 }] })
  ──► 4 delta rows:
        state:NY     sales              -75c
        county:NY-NYC sales              -22c
        city:NY-NYC   sales              -18c
        state:NY     bottle_deposit    -500c
  sum: -615c (exactly half of line A's 1231c net)
```

Apply the delta: `ledger.with(delta)`. The live ledger's net by jurisdiction is now \$2.94 sales tax + \$0.03 shipping tax + \$5.00 deposit = \$7.97. To the cent.

## Invariants the test suite proves

Every property holds over 500-1000 random orders generated by `fast-check`:

- **Sum-equals-total.** `sum(split(input).taxes) === input.totalTaxCents` (with a 1-cent rounding-residual row if the engine itself drifted).
- **Refund-sums-back.** `sum(refund(ledger, spec)) === -spec.amountCents` to the cent.
- **No fractional cents.** Every emitted `amountCents` is an integer.
- **Allocator total preservation.** `sum(allocate(totalCents, weights)) === totalCents` for any positive or negative total.
- **Idempotent reconcile.** `revise(ledger, sameOrder)` is always a no-op. Replay of the same event produces the same delta.
- **No-collapse jurisdiction.** Every `(jurisdiction, taxType)` on the source line is preserved as its own row, refunded proportionally.

54 tests total in `@tax-ledger/core`, including ~21 property tests at 500-1000 runs each. Each commit on the branch keeps the suite green.

## v0.1 scope (shipped)

| Module | Status |
|---|---|
| `@tax-ledger/core` — `split()`, `refund()`, `partialCapture()`, `revise()` | ✓ shipped |
| Decimal.js + largest-remainder allocator | ✓ shipped |
| Zod-validated input boundary | ✓ shipped |
| Property-based test suite (`fast-check`) | ✓ shipped |
| `examples/basic` — runnable Avalara → ledger → refund demo | ✓ shipped |

## Deferred to v0.2+

| Module | Notes |
|---|---|
| `@tax-ledger/sources-avalara` | Adapter from Avalara `TransactionModel`. The `toOrderInput()` in `examples/basic/run.ts` previews the shape. |
| `@tax-ledger/sources-taxjar` | TaxJar `TaxResponse` adapter. Same contract. |
| `@tax-ledger/sources-stripe-tax` | Stripe `Tax.Calculation` adapter. |
| `@tax-ledger/postgres` | Drizzle schema (append-only `tax_ledger_rows` table + materialized rollup view) and repository. Migrations included. |
| `@tax-ledger/nestjs` | `TaxLedgerModule.forRoot({ source, persistence })` for DI-friendly integration. |
| `@tax-ledger/cli` | `tax-ledger reconcile <file>` and `tax-ledger audit <db>` for offline debugging. |
| `VoidEvent` + `AddressChangeEvent` | Specialized reconcile events. Address-change works today as a `revise()` with new jurisdictions appearing — explicit event surface lands in v0.2. |

See [`PLAN.md`](./PLAN.md) for the full architecture, schema, and roadmap.

## Decisions log

| # | Decision | What we picked | Why |
|---|---|---|---|
| 1 | npm scope | `@tax-ledger/*` | Matches the rest of the workspace conventions. Adapters and core ship independently. |
| 2 | Single package vs monorepo | Monorepo | Adapters carry weight (Avalara SDK, TaxJar SDK). Consumers should be able to install `@tax-ledger/core` standalone. |
| 3 | Money primitive | `decimal.js` for intermediate math, integer cents for I/O | Arbitrary precision avoids both FP drift and BigInt footguns on rates with >2 decimal places. |
| 4 | Allocation strategy | Largest-remainder (Hamilton's method) | Sum-preserving by construction. Deterministic tiebreak by row id asc keeps replays stable. |
| 5 | Validation | Zod at the input boundary | Engine responses are JSON, untyped. Validate once, trust downstream. |
| 6 | Build | tsup (ESM + CJS) | Dual emit with one config file. Pure-TS package, no native deps. |
| 7 | Tests | Vitest + `fast-check` | Property-based tests are the headline feature. Vitest's TS-native runner avoids ts-jest config sprawl. |
| 8 | Ledger mutability | Append-only, deltas as new rows | An auditable ledger that never mutates is a precondition for shipping to accounting. |

## Contributing

```bash
pnpm install
pnpm build      # tsup builds @tax-ledger/core
pnpm typecheck  # tsc --noEmit
pnpm test       # vitest run — 54 tests
```

PRs welcome. Open an issue first for new adapter packages so we can claim the npm name in the `@tax-ledger` scope.

## License

MIT.
