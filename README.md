# tax-ledger

> Line-item tax splitter + reconciliation engine. Sits downstream of Avalara, TaxJar, Stripe Tax. Takes their per-jurisdiction totals plus your line items and emits a deterministic ledger: per-line, per-jurisdiction, per-tax-type rows that sum back to the engine's total to the cent and stay reconciled across refunds, partial captures, and revisions.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Status](https://img.shields.io/badge/status-v1.0-brightgreen)](#v10-scope-shipped)
[![Tests](https://img.shields.io/badge/tests-110-success)](#invariants-the-test-suite-proves)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](#install)

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

MIT, public from day one. v1.0 ships `@tax-ledger/core` (the pure splitter + reconciler) plus engine adapters for Avalara, TaxJar, and Stripe Tax, an opinionated Drizzle ORM adapter for persistence, and multi-currency support in the core. NestJS and CLI sugar are still on the roadmap.

## Contents

- [Why it exists](#why-it-exists)
- [Install](#install)
- [Quick start](#quick-start)
- [Worked example: bottle-deposit refund](#worked-example-bottle-deposit-refund)
- [Invariants the test suite proves](#invariants-the-test-suite-proves)
- [v1.0 scope](#v10-scope-shipped)
- [Adapters](#adapters)
- [Persistence (Drizzle)](#persistence-drizzle)
- [Multi-currency](#multi-currency)
- [Roadmap](#on-the-roadmap)
- [Decisions log](#decisions-log)

## Why it exists

Every team that ships sales tax in production ends up with the same 1,000-line ratio-and-`Math.floor` blob smeared across their refund flow. After three partial refunds the books drift a few cents. After a thousand orders, a few dollars. Accountants get involved.

`@tax-ledger/core` is that 1,000 lines factored out into a ~600-line pure function with property-based tests proving the books always reconcile. The math:

- **Largest-remainder (Hamilton's method)** allocation, not ratio truncation. The sum of allocated integer cents equals the input cents exactly.
- **Decimal.js** for the intermediate math. No FP drift, no `Math.floor(ratio * tax)` cliff.
- **Append-only ledger.** Refunds, captures, and revisions emit delta entries — they don't mutate prior rows. Replay is a fold.

## Install

```bash
pnpm add @tax-ledger/core
# + any adapter(s) you want
pnpm add @tax-ledger/avalara @tax-ledger/taxjar @tax-ledger/stripe-tax
# + persistence
pnpm add @tax-ledger/drizzle drizzle-orm
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

The source lives in [`examples/basic/`](./examples/basic/) — Avalara JSON in, ledger printed out.

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

110 tests across the workspace (60 in `@tax-ledger/core`, including ~21 property tests at 500-1000 runs each; plus adapter fixtures and a SQLite smoke suite). Each commit on the branch keeps the suite green.

## v1.0 scope (shipped)

| Module | Status |
|---|---|
| `@tax-ledger/core` — `split()`, `refund()`, `partialCapture()`, `revise()` | shipped |
| Decimal.js + largest-remainder allocator | shipped |
| Zod-validated input boundary (`TaxInput`) | shipped |
| Property-based test suite (`fast-check`) | shipped |
| Multi-currency support (ISO-4217 codes; mixed-currency reconcile refused) | shipped |
| `@tax-ledger/avalara` — `CreateTransactionModel` → `TaxInput` adapter | shipped |
| `@tax-ledger/taxjar` — `taxes` response → `TaxInput` adapter | shipped |
| `@tax-ledger/stripe-tax` — `Tax.Calculation` → `TaxInput` adapter | shipped |
| `@tax-ledger/drizzle` — PG + SQLite schema, `persistLedger`, `applyDelta`, migration generator | shipped |
| `examples/basic` — runnable Avalara → ledger → refund demo | shipped |

## Adapters

Every adapter exports a `toTaxInput(response, options?)` function that maps the engine-shaped JSON to the engine-agnostic `TaxInput`. The Zod schema mirrors each engine's public response shape — invalid payloads throw at the boundary.

```ts
// Avalara — pass the CreateTransactionModel response verbatim.
import { toTaxInput as fromAvalara } from '@tax-ledger/avalara';
const input = fromAvalara(avalaraResponse);

// TaxJar — flat response; caller passes per-line metadata (qty + unit price).
import { toTaxInput as fromTaxJar } from '@tax-ledger/taxjar';
const input = fromTaxJar(taxjarResponse, {
  orderId: 'order_42',
  lineItems: [{ id: 'A', quantity: 2, unitAmountCents: 2499 }],
});

// Stripe Tax — already in cents, currency on root.
import { toTaxInput as fromStripe } from '@tax-ledger/stripe-tax';
const input = fromStripe(taxCalculation);
```

Each adapter has unit tests against a canonical fixture response (NY for Avalara, CA for TaxJar, WA + DE-VAT for Stripe Tax) plus edge cases (exempt items, free shipping, EU VAT).

## Persistence (Drizzle)

`@tax-ledger/drizzle` ships two parallel schemas — `pg` and `sqlite` — with the same column names. Pick the one matching your driver:

```ts
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  persistLedger,
  applyDelta,
  generateMigration,
  sqlite,
} from '@tax-ledger/drizzle';

const db = drizzle(new Database('app.db'));
db.run(generateMigration('sqlite').up); // or feed to drizzle-kit

await persistLedger(db, ledger, { dialect: 'sqlite' });

const delta = refund(ledger, { refundId: 'rf_1', lines: [{ lineItemId: 'A', amountCents: 100 }] });
await applyDelta(db, ledger.rows[0].id, delta, { dialect: 'sqlite' });
```

<details>
<summary><b>Schema</b> — append-only entries + delta cross-reference</summary>

- `tax_ledger_entries` — append-only. One row per emitted `LedgerEntry` (split rows, refund/capture/revision deltas). Columns include `id`, `order_id`, `line_item_id`, `jurisdiction_type`, `jurisdiction_code`, `tax_type`, `currency`, `amount_cents` (integer, signed), `event_kind` (`split` | `refund` | `partial_capture` | `revise`), `event_ref`, `engine_ref`, `created_at`.
- `tax_ledger_deltas` — cross-reference table linking a delta entry back to its originating split entry. Optional; populated by `applyDelta`.

`generateMigration('pg' | 'sqlite')` returns `{ up, down }` raw DDL — hand it to `drizzle-kit`, Atlas, or `db.exec()` directly.

</details>

## Multi-currency

`TaxInput.currency` is an ISO-4217 code (three uppercase letters, validated by Zod). The ledger carries it on every row. The reconciliation operations refuse mixed-currency cross-references with `CurrencyMismatchError`:

- `Ledger.with(delta)` — every delta entry's currency must match the ledger's.
- `revise(ledger, { newOrder })` — `newOrder.currency` must match `ledger.currency`.

The core doesn't perform FX conversion — that's a separate boundary upstream. If you need to reconcile a USD ledger against an EUR revision, convert first, then revise.

## On the roadmap

- [ ] `@tax-ledger/nestjs` — `TaxLedgerModule.forRoot({ source, persistence })` for DI-friendly integration.
- [ ] `@tax-ledger/cli` — `tax-ledger reconcile <file>` and `tax-ledger audit <db>` for offline debugging.
- [ ] `VoidEvent` + `AddressChangeEvent` — explicit event surface. Address-change works today as a `revise()` with new jurisdictions appearing.
- [ ] Materialized rollup view — `tax_ledger_rollup` pre-aggregated net by `(orderId, jurisdiction, taxType)` for accounting exports.

<details>
<summary><b>Out of scope</b> — what tax-ledger won't do</summary>

- **Rate lookup.** That's what Avalara/TaxJar/Stripe Tax exist for. We sit downstream of the rate engine.
- **Filing.** A separate concern (`stripe-eu-vat-moss` exists for EU OSS filing). The ledger is the data behind a filing, not the filer.
- **FX conversion.** Single-currency per ledger. Convert upstream before revising into a different currency.
- **Customer-facing pricing.** The split is for accounting, not for showing on a receipt — the engine's per-line `tax` field is for that.

</details>

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
| 9 | Multi-currency | One ISO-4217 code per ledger; refuse mixed-currency reconcile | FX belongs upstream. The ledger's job is integer cents in a single denomination. |
| 10 | Drizzle dialects | Parallel PG + SQLite schemas, same column names | Lets the same persistence code work in production (PG) and tests (SQLite). |

## Contributing

```bash
pnpm install
pnpm build      # tsup builds every package
pnpm typecheck  # tsc --noEmit across the workspace
pnpm test       # vitest run — 110 tests across 5 packages
```

PRs welcome. Open an issue first for new adapter packages so we can claim the npm name in the `@tax-ledger` scope.

## License

MIT · [@mateokadiu](https://github.com/mateokadiu)
