# `tax-ledger` — Implementation Plan

> The line-item splitter + reconciliation engine that sits **downstream** of Avalara / TaxJar / Stripe Tax. Takes their per-jurisdiction tax totals and your line items, emits a deterministic ledger with per-line, per-jurisdiction, per-tax-type rows that always sum back to the source total — then keeps doing the math correctly across refunds, partial captures, and revisions. Public OSS, MIT.

**Status:** Draft — pending decisions in §11 before Phase 0 starts.

---

## 1. Goals & non-goals

### Goals
- A pure-TS library that takes a **tax engine response** (Avalara `TransactionModel`, TaxJar `TaxResponse`, Stripe Tax `Calculation`, or a generic input) plus **line items** and produces a **`TaxLedger`** — a flat list of rows `(orderId, lineItemId, jurisdiction, taxType, amountCents)` that sums back to the engine's total to the cent.
- A **reconciler** that, given a prior ledger and an event (refund, partial capture, line revision, address change, void), emits **deltas** — new ledger rows with negative or adjusting amounts — that are themselves first-class ledger entries.
- **Zero drift** across an arbitrary sequence of refunds and revisions. Property-based tests prove `sum(ledger.deltas) == sum(refundTotals)` and `sum(ledger.live) == sum(remainingEngineTotals)` for every operation.
- **Four canonical tax types** out of the box, matching the breakdown every retailer accounting team eventually needs: `sales`, `shipping`, `bottle_deposit`, `additional` (excise / platform-fee tax / retail delivery fee / bag fee). Extensible — consumers can register more.
- **`Decimal.js` everywhere.** No floating point. No `Math.floor(ratio * tax)` drift. Allocation is done with a **largest-remainder method**, not ratio truncation.
- **Pure core, opt-in adapters.** Core is in-memory, no I/O. Postgres + Drizzle adapter ships as `@tax-ledger/postgres`. NestJS module ships as `@tax-ledger/nestjs`. CLI ships as `@tax-ledger/cli`.
- **Source adapters** for the three major tax engines: `@tax-ledger/sources-avalara`, `@tax-ledger/sources-taxjar`, `@tax-ledger/sources-stripe-tax`. Each is a thin shape-mapper; the engine output is the source of truth, the ledger is just the projection.
- **OSS, MIT.** Public on GitHub from day one. npm under `@tax-ledger/*`.

### Non-goals (for v1)
- **NOT a tax calculator.** No rate lookups, no nexus determination, no jurisdiction inference, no exemption certificates. Those are upstream — use Avalara / TaxJar / Stripe Tax for that. This package does not even know what a sales-tax rate is.
- No filing / returns / remittance. That's Avalara Returns, TaxJar AutoFile, etc.
- No address validation, no geolocation. Pass clean addresses in.
- No SKU-level taxability rules engine. The engine response already encodes that.
- No multi-currency conversion. Whatever currency the engine emits, the ledger emits.
- No UI components — admin tools that consume the ledger live elsewhere.
- No subscription or recurring-billing model — those are just sequences of orders to this library.

---

## 2. The problem

Avalara returns this for a 3-item order shipping into New York (one beer, one snack, one shipping fee, plus a $5 bottle deposit):

```jsonc
{
  "code": "ORDER-123",
  "totalTax": 4.12,
  "totalAmount": 56.50,
  "lines": [
    {
      "lineNumber": "1", "ref1": "beer_sku_a",
      "lineAmount": 24.99, "tax": 2.31,
      "details": [
        { "jurisdictionType": "State",   "taxType": "Sales",  "tax": 1.50 },
        { "jurisdictionType": "County",  "taxType": "Sales",  "tax": 0.45 },
        { "jurisdictionType": "City",    "taxType": "Sales",  "tax": 0.36 },
        { "jurisdictionType": "State",   "taxType": "Bottle", "tax": 0.00 }
      ]
    },
    {
      "lineNumber": "2", "ref1": "snack_sku_b",
      "lineAmount": 19.99, "tax": 1.78,
      "details": [ /* state/county/city sales tax */ ]
    },
    {
      "lineNumber": "3", "ref1": "shippingFee",
      "lineAmount": 6.52, "tax": 0.03,
      "details": [ /* state shipping tax */ ]
    }
  ],
  "summary": [ /* per-jurisdiction roll-ups — DO NOT also sum these, they double-count */ ]
}
```

And the **bottle deposit** of \$5? That isn't in Avalara's tax output at all. It rode along as a separate line (often `taxCode = "OF400000"` non-taxable), and you're expected to track it yourself.

Now refund one beer at half quantity. Every team in production does the same thing:

```ts
// The wrong, drift-prone version that ships everywhere
const refundRatio = refundQty / originalQty;
const refundedTax = Math.floor(line.tax * refundRatio);
const refundedDeposit = Math.floor(deposit * refundRatio);
// ...repeat for 6 more variables, accumulate rounding errors across refunds.
```

After three partial refunds the books are off by a few cents. After a thousand orders, by a few dollars. Accountants get involved.

### What this library guarantees

1. **The split is exact.** For every line item, the per-tax-type, per-jurisdiction breakdown is materialized as ledger rows. The sum of rows equals the engine's `totalTax`. We assert this on construction and fail loudly if the engine's output isn't internally consistent.
2. **The refund delta is exact.** Allocating a refund of $N tax across rows uses the **largest-remainder method** with `Decimal.js` math, so the cent allocations sum back to N exactly — not N±k cents.
3. **Reconciliation is idempotent.** Replaying the same refund event against the same prior ledger produces the same delta rows (same ids, same amounts). No double-charging.
4. **Bottle deposits are first-class.** Not lumped in with sales tax, not a separate field hung off the order. A ledger row with `taxType: 'bottle_deposit'` and an `amountCents`, scoped to the line and the depositing jurisdiction.
5. **Multi-jurisdiction is first-class.** An order shipping NY→CA with stopover excise gets one row per `(line, jurisdiction, taxType)`. No collapsing.

### Worked example: split → refund → delta

**Order:** 3 lines. Line A (beer, \$24.99, qty 2, \$5 bottle deposit per unit). Line B (snack, \$19.99, qty 1). Line C (shipping, \$6.52). NY shipping address.

Engine returns:
- Line A tax: state \$1.50, county \$0.45, city \$0.36 sales. \$5.00 bottle deposit (× 2 = \$10.00, treated by engine as line C2 ref `bottle_deposit_beer`).
- Line B tax: state \$1.20, county \$0.36, city \$0.22 sales.
- Line C tax: state \$0.03 shipping tax.

**Initial split** → 9 ledger rows. Sum = \$4.12 tax + \$10.00 deposit = \$14.12. Matches engine.

**Refund:** 1 unit of line A.

Reconciler:
- Identifies all rows where `lineItemId = "A"`.
- Refund ratio = 1/2 = 0.5.
- For each row: compute `row.amountCents * Decimal(0.5)`. Apply largest-remainder rounding **across the set** so the sum of refunded cents equals exactly half of the original line A's row sum. For Line A's tax-row group: \$1.50 + \$0.45 + \$0.36 = \$2.31. Half = \$1.155 → round to \$1.16 with the residual cent allocated to the row whose decimal remainder is largest. Bottle deposit: \$10.00 / 2 = exactly \$5.00.
- Emits 4 delta rows: `(A, NY-state, sales, -76)`, `(A, NY-county, sales, -23)`, `(A, NY-city, sales, -17)`, `(A, NY-state, bottle_deposit, -500)`. Sum = -\$11.16. This is the buyer's tax refund. Matches the same calculation on the engine side when you'd ask Avalara to `adjustTransaction` for that refund.

**Live ledger after refund:** original 9 rows + 4 negative delta rows. `sum(live)` = `$14.12 - $11.16 = $2.96`. The reconciler can be asked at any time for the **net per (line, jurisdiction, taxType)**, which is what your accounting export needs.

This is the calculation that the internal `OrderTaxesService` in `vault/src/modules/orders/services/order.taxes.service.ts` does in 1,000 lines of ad-hoc ratios, `Math.floor`s, and special-case branches for shipping fee / service fee / tip. **It should be a 200-line pure function with property-based tests.** That's `@tax-ledger/core`.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Your app                                                                 │
│                                                                          │
│   ┌─────────────────────┐                                                │
│   │ Checkout flow       │                                                │
│   │  - quote()          │                                                │
│   │  - commit()         │                                                │
│   └──────────┬──────────┘                                                │
│              │                                                           │
│              ▼                                                           │
│   ┌─────────────────────┐         ┌──────────────────────────────────┐  │
│   │ Tax engine          │         │ tax-ledger                       │  │
│   │  - Avalara          │ resp →  │                                  │  │
│   │  - TaxJar           │────────▶│  @tax-ledger/sources-avalara     │  │
│   │  - Stripe Tax       │         │   .toLedgerInput(transactionModel│  │
│   └─────────────────────┘         │                  , orderContext) │  │
│                                   │              │                   │  │
│                                   │              ▼                   │  │
│                                   │  @tax-ledger/core                │  │
│                                   │   .split(ledgerInput)            │  │
│                                   │     → TaxLedger (rows[])         │  │
│                                   │                                  │  │
│                                   │   .reconcile(prior, event)       │  │
│                                   │     → TaxLedgerDelta             │  │
│                                   │       (rows[] with deltas)       │  │
│                                   │                                  │  │
│                                   │  ┌────────────────────────────┐  │  │
│                                   │  │ Allocator (largest-rem)    │  │  │
│                                   │  │ Decimal.js — no FP drift   │  │  │
│                                   │  └────────────────────────────┘  │  │
│                                   │                                  │  │
│                                   │   .invariants(ledger)            │  │
│                                   │     throws on drift              │  │
│                                   └─────────────┬────────────────────┘  │
│                                                 │                       │
│                       ┌─────────────────────────┼─────────────────────┐ │
│                       ▼                         ▼                     ▼ │
│            @tax-ledger/postgres        @tax-ledger/nestjs      Your DB  │
│            (Drizzle schema +           (TaxLedgerModule,                │
│             repo + migrations)          DI-friendly service)            │
└──────────────────────────────────────────────────────────────────────────┘
                                                  │
                                                  ▼
                                       ┌─────────────────────┐
                                       │ @tax-ledger/cli     │
                                       │  reconcile <file>   │
                                       │  audit  <db-url>    │
                                       └─────────────────────┘
```

**Data flow contracts**:

```
Avalara TransactionModel ──┐
TaxJar TaxResponse        ─┼─► LedgerInput ─► split() ─► TaxLedger ──┐
Stripe Tax Calculation    ─┘                                          │
                                                                      │
                                                                      ▼
                          RefundEvent / CaptureEvent / ReviseEvent ─► reconcile()
                                                                      │
                                                                      ▼
                                                              TaxLedgerDelta
                                                                      │
                                                                      ▼
                                                              live = prior ⊕ delta
```

Everything past `LedgerInput` is engine-agnostic. Adapters are dumb shape-mappers — no math.

---

## 4. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript 5.7+, ESM | Strict types over the ledger row shape are load-bearing |
| Money math | **`decimal.js` 10** | Arbitrary precision, well-trodden, no BigInt cents footgun where rates have 4+ decimals (NY metro commuter tax is 0.34375%) |
| Validation | Zod 3 | Runtime guards on every adapter boundary — engine responses are untyped JSON |
| Build | tsup | Dual ESM/CJS emit, single config |
| Tests | Vitest 2 + **`fast-check` 3** | Property-based tests are the whole point — invariants over random inputs |
| Lint | ESLint 9 (flat config) + `@typescript-eslint` strict | Catch implicit-any over the adapter surface |
| Monorepo | pnpm workspaces + Turborepo | Matches the user's other projects |
| Versioning | Changesets | Per-package versioning — `core` and adapters move independently |
| Postgres adapter | Drizzle (peer dep) | Schema-first, raw SQL escape hatch for ledger window queries |
| NestJS adapter | NestJS 11 (peer dep) | `@Module({ imports: [TaxLedgerModule.forRoot({...})] })` |
| CLI | `commander` + `kleur` | No framework; this is one binary with two subcommands |
| CI | GitHub Actions | Lint + typecheck + test + property-test budget enforced |
| Release | `changesets/action` | Tag → publish each changed package |
| Docs | Markdown in repo, Mintlify-ready structure | Migrate later if traction warrants |

---

## 5. Public API

### 5.1 `@tax-ledger/core`

```ts
import {
  split,
  reconcile,
  invariants,
  type LedgerInput,
  type TaxLedger,
  type TaxLedgerRow,
  type TaxLedgerDelta,
  type RefundEvent,
  type CaptureEvent,
  type ReviseEvent,
  type VoidEvent,
} from '@tax-ledger/core';

// 1) Initial split — from engine response → ledger
const ledger: TaxLedger = split(input);

// 2) Reconcile a refund — produce delta rows
const delta: TaxLedgerDelta = reconcile(ledger, {
  type: 'refund',
  refundId: 'rf_01J9Z...',
  lines: [{ lineItemId: 'A', quantity: 1 }],            // partial line refund
  fees:  [{ feeKind: 'shipping', amountCents: 326 }],   // half the shipping fee
  reason: 'customer_request',
});

// 3) Apply delta — new live ledger (immutable append)
const live: TaxLedger = ledger.with(delta);

// 4) Assertions — explode on drift
invariants(live);          // throws TaxLedgerInvariantError if sums don't reconcile
```

#### 5.1.1 `LedgerInput` (engine-agnostic)

```ts
interface LedgerInput {
  orderId: string;
  currency: string;                       // ISO-4217: 'USD', 'EUR'
  engineRef: string;                      // Avalara code / TaxJar tx id / Stripe calc id
  totalTaxCents: number;                  // engine's declared total — used as cross-check
  lines: ReadonlyArray<LedgerInputLine>;
  fees:  ReadonlyArray<LedgerInputFee>;   // shipping / service / platform / tip / bag
}

interface LedgerInputLine {
  lineItemId: string;                     // your stable id (NOT the engine's lineNumber)
  quantity: number;                       // integer
  unitAmountCents: number;
  taxes: ReadonlyArray<LedgerInputTax>;   // already broken down by engine
  deposits: ReadonlyArray<LedgerInputDeposit>;
}

interface LedgerInputTax {
  jurisdiction: { type: 'state' | 'county' | 'city' | 'special' | 'country'; code: string };
  taxType: 'sales' | 'shipping' | 'additional';
  amountCents: number;
}

interface LedgerInputDeposit {
  jurisdiction: { type: 'state' | 'country'; code: string };
  amountCents: number;                    // bottle / container deposit
}

interface LedgerInputFee {
  feeKind: 'shipping' | 'service' | 'platform' | 'tip' | 'bag' | 'retail_delivery' | string;
  amountCents: number;
  taxes: ReadonlyArray<LedgerInputTax>;   // typically 'shipping' or 'additional' taxType
}
```

#### 5.1.2 `TaxLedgerRow` (the canonical row)

```ts
interface TaxLedgerRow {
  readonly id: string;                    // uuidv7 — sortable, generated by core
  readonly orderId: string;
  readonly scope:
    | { kind: 'line';  lineItemId: string }
    | { kind: 'fee';   feeKind: string }
    | { kind: 'order'; reason: 'rounding_residual' };
  readonly jurisdiction: { type: string; code: string };
  readonly taxType: 'sales' | 'shipping' | 'bottle_deposit' | 'additional';
  readonly amountCents: number;           // signed — negatives are deltas
  readonly origin:
    | { kind: 'split';     engineRef: string }
    | { kind: 'refund';    refundId: string }
    | { kind: 'capture';   captureId: string }
    | { kind: 'revision';  revisionId: string }
    | { kind: 'void';      voidId: string };
  readonly createdAt: string;             // ISO-8601, frozen at construction
}
```

#### 5.1.3 `TaxLedger` (an append-only collection)

```ts
class TaxLedger {
  readonly rows: ReadonlyArray<TaxLedgerRow>;
  readonly orderId: string;
  readonly currency: string;

  // Net amount by any slice
  netCents(by?: Partial<{ taxType: string; jurisdictionType: string; scope: 'line' | 'fee' | 'order' }>): number;

  // Per-(scope, jurisdiction, taxType) net rollup — what you export to accounting
  rollup(): ReadonlyArray<TaxLedgerRollup>;

  // Append immutably
  with(delta: TaxLedgerDelta): TaxLedger;

  // Serialize — JSON-safe, stable key order, exact for snapshot tests
  toJSON(): TaxLedgerJSON;
  static fromJSON(json: TaxLedgerJSON): TaxLedger;
}
```

#### 5.1.4 Events the reconciler understands

```ts
type ReconcileEvent =
  | RefundEvent
  | CaptureEvent
  | ReviseEvent
  | VoidEvent
  | AddressChangeEvent;       // ships behind a flag in v0.2 — see Decisions

interface RefundEvent {
  type: 'refund';
  refundId: string;
  lines?: ReadonlyArray<{ lineItemId: string; quantity?: number; amountCents?: number }>;
  fees?:  ReadonlyArray<{ feeKind: string; amountCents?: number }>;       // partial fee refund
  reason?: string;
}

interface CaptureEvent {
  type: 'capture';
  captureId: string;
  capturedAmountCents: number;             // partial capture — reconciles tax to the captured share
}

interface ReviseEvent {
  type: 'revision';
  revisionId: string;
  newEngineResponse: LedgerInput;          // engine recomputed; we diff vs prior live ledger
}

interface VoidEvent {
  type: 'void';
  voidId: string;
  reason?: string;
}
```

### 5.2 `@tax-ledger/sources-avalara`

```ts
import type { TransactionModel } from 'avatax/lib/models';
import { toLedgerInput, type AvalaraAdapterOpts } from '@tax-ledger/sources-avalara';

const input = toLedgerInput(transaction, {
  orderId: order.id,
  lineItemIdFromRef1: true,                // ref1 carries your stable line id
  feeRefMap: {
    shippingFee: 'shipping',
    serviceFee:  'service',
    tip:         'tip',
    checkoutBag: 'bag',
    retailDeliveryFee: 'retail_delivery',
  },
  bottleDepositTaxType: 'Bottle',          // Avalara `details[].taxType` for deposits
});
```

### 5.3 `@tax-ledger/sources-taxjar` and `-stripe-tax`

Same shape, different mappings. Each one ships table-driven adapter tests against canonical engine fixtures committed in `__fixtures__/`.

### 5.4 `@tax-ledger/postgres`

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { TaxLedgerRepository, taxLedgerSchema } from '@tax-ledger/postgres';

const repo = new TaxLedgerRepository(drizzle(pool, { schema: taxLedgerSchema }));

await repo.persist(ledger);
const live = await repo.loadByOrderId('order_123');
await repo.appendDelta('order_123', delta);
```

### 5.5 `@tax-ledger/nestjs`

```ts
@Module({
  imports: [
    TaxLedgerModule.forRoot({
      source: 'avalara',
      adapter: { /* Avalara opts */ },
      persistence: { kind: 'postgres', drizzle: db },
    }),
  ],
})
export class OrdersModule {}

@Injectable()
class OrderRefundsService {
  constructor(private readonly tax: TaxLedgerService) {}
  async refund(orderId: string, lines: RefundLine[]) {
    const delta = await this.tax.reconcileRefund(orderId, { refundId, lines });
    return delta;       // already persisted by the service
  }
}
```

### 5.6 `@tax-ledger/cli`

```
$ tax-ledger reconcile ./order.json --against ./refund.json
✓ split: 12 rows, sum $4.12 — matches engine
✓ refund: 4 delta rows, sum -$1.16 — matches refund
✓ invariants: pass

$ tax-ledger audit postgres://… --order order_123
ORDER order_123 — currency USD
  Live ledger: 16 rows · sales $2.41 · shipping $0.03 · deposit $5.00 · additional $0.00
  Drift vs engine: $0.00  ✓
```

---

## 6. Project structure

```
tax-ledger/
├── PLAN.md
├── README.md
├── LICENSE                              MIT
├── package.json                          workspace root
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── .changeset/
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── release.yml
├── packages/
│   ├── core/                            @tax-ledger/core
│   │   ├── src/
│   │   │   ├── input/
│   │   │   │   ├── schema.ts            zod schemas for LedgerInput*
│   │   │   │   └── normalize.ts         canonicalize jurisdictions, drop zero-amount rows
│   │   │   ├── split/
│   │   │   │   ├── split.ts             LedgerInput → TaxLedger
│   │   │   │   └── allocator.ts         largest-remainder allocation, Decimal.js
│   │   │   ├── reconcile/
│   │   │   │   ├── refund.ts
│   │   │   │   ├── capture.ts
│   │   │   │   ├── revise.ts
│   │   │   │   ├── void.ts
│   │   │   │   └── dispatch.ts          ReconcileEvent → delta
│   │   │   ├── ledger/
│   │   │   │   ├── ledger.ts            TaxLedger class
│   │   │   │   ├── rollup.ts
│   │   │   │   └── invariants.ts
│   │   │   ├── ids.ts                   uuidv7
│   │   │   ├── money.ts                 Decimal helpers; cents↔decimal; no FP escapes
│   │   │   ├── errors.ts                TaxLedgerInvariantError, AllocationError, …
│   │   │   └── index.ts
│   │   ├── test/
│   │   │   ├── split.test.ts
│   │   │   ├── refund.test.ts
│   │   │   ├── capture.test.ts
│   │   │   ├── revise.test.ts
│   │   │   ├── invariants.test.ts
│   │   │   ├── property/
│   │   │   │   ├── sum-equals-total.spec.ts          fast-check
│   │   │   │   ├── refund-deltas-sum-to-refund.spec.ts
│   │   │   │   ├── reconcile-idempotent.spec.ts
│   │   │   │   ├── replay-equivalence.spec.ts
│   │   │   │   └── largest-remainder.spec.ts
│   │   │   └── __fixtures__/
│   │   │       ├── ny-3-items-with-deposit.json
│   │   │       ├── ca-shipping-from-or.json
│   │   │       └── partial-capture-with-revision.json
│   │   ├── tsup.config.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── sources-avalara/                 @tax-ledger/sources-avalara
│   │   ├── src/
│   │   │   ├── to-ledger-input.ts
│   │   │   ├── jurisdiction.ts          AvaTax jurisdictionType → ledger juris.type
│   │   │   ├── tax-type.ts              AvaTax taxType → ledger taxType
│   │   │   └── index.ts
│   │   ├── test/
│   │   │   └── __fixtures__/            real-shape redacted AvaTax responses
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── sources-taxjar/                  @tax-ledger/sources-taxjar
│   ├── sources-stripe-tax/              @tax-ledger/sources-stripe-tax
│   ├── postgres/                        @tax-ledger/postgres
│   │   ├── src/
│   │   │   ├── schema.ts                Drizzle schema: tax_ledger_rows
│   │   │   ├── repository.ts
│   │   │   ├── migrations/
│   │   │   └── index.ts
│   │   ├── test/                         testcontainers PG
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── nestjs/                          @tax-ledger/nestjs
│   │   ├── src/
│   │   │   ├── tax-ledger.module.ts
│   │   │   ├── tax-ledger.service.ts
│   │   │   └── index.ts
│   │   ├── test/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── cli/                             @tax-ledger/cli
│       ├── src/
│       │   ├── bin.ts                    `tax-ledger` entry
│       │   ├── reconcile.cmd.ts
│       │   ├── audit.cmd.ts
│       │   └── render.ts                 table/JSON output
│       ├── test/
│       ├── package.json
│       └── tsconfig.json
└── examples/
    └── basic/
        ├── avalara-response.json
        ├── refund.json
        ├── run.ts                        end-to-end: Avalara → ledger → refund → delta → print
        ├── package.json
        └── README.md
```

---

## 7. Key flows

### 7.1 Initial split

```
LedgerInput arrives (already validated by zod).

For each line:
  For each (jurisdiction, taxType) tax detail:
    emit a row { scope=line, taxType, jurisdiction, amountCents }
  For each deposit:
    emit a row { scope=line, taxType=bottle_deposit, jurisdiction, amountCents }

For each fee:
  For each tax detail on the fee:
    emit a row { scope=fee[feeKind], taxType, jurisdiction, amountCents }

Compute sum(rows.amountCents).
If sum != input.totalTaxCents + sum(deposits):
  - If diff == 1 cent (rounding residual in the engine): emit a `scope=order, reason='rounding_residual'`
    row to absorb the difference. Log a warning.
  - If diff > 1 cent: throw TaxLedgerInvariantError. The engine response is internally inconsistent;
    refuse to produce a ledger.
```

Bottle deposits are summed into the invariant check (they're part of the "what the buyer paid above the subtotal" bucket). Whether they're considered a tax for accounting depends on jurisdiction — the ledger keeps them tagged distinctly so consumers can decide.

### 7.2 Refund delta

```
RefundEvent: { lines: [{ lineItemId, quantity? | amountCents? }], fees: [...] }

For each refunded line:
  base = currentRowsForLine(lineItemId)   // live live = prior with any earlier deltas applied
  ratio = quantity != null
            ? Decimal(quantity) / Decimal(currentRemainingQty(lineItemId))
            : Decimal(amountCents) / Decimal(currentRemainingAmount(lineItemId))
  groupBy taxType: for each group:
    refundTotalCents = sum(group) * ratio  // exact Decimal
    allocate refundTotalCents across group's rows by largest-remainder method
    emit one negative delta row per source row

For each refunded fee:
  same shape — partial fee refund supported via amountCents

Sum of emitted deltas:
  must equal sum(refund.expectedBuyerTaxDelta) — buyer-facing total computed by allocator
  invariants.checkDelta(delta) — throws on mismatch
```

The reconciler **does not call the engine**. It works off the live ledger. If you want Avalara to also reflect the refund (for filing purposes), call `adjustTransaction` separately — the ledger will be the source of truth for the buyer-facing numbers regardless.

### 7.3 Capture delta (partial capture)

When a manual-capture PaymentIntent is captured for less than the auth amount:

```
CaptureEvent: { capturedAmountCents }

ratio = Decimal(capturedAmountCents) / Decimal(originalOrderTotalCents)

For each tax row in the live ledger:
  capturedAmount = row.amountCents * ratio
  emit a delta row for the *uncaptured* portion as a negative
  i.e. delta = -(row.amountCents - capturedAmount)

The captured portion remains in the live ledger as-is + the delta nets it down to ratio'd amount.
```

This is what most teams forget on partial captures. The auth was for \$100 + \$8.25 tax, you capture \$80 — Stripe captures the \$80 against the auth, but the **tax due to the jurisdiction** is now \$80 / \$100 × \$8.25 = \$6.60, not \$8.25. Without a ledger, the books say you owe \$8.25.

### 7.4 Revision delta

When you decrease an order total (line removed, item swap, address change):

```
ReviseEvent: { newEngineResponse: LedgerInput }

priorLive = currentRollup(ledger)        // (line, jurisdiction, taxType) → cents
newSplit  = split(newEngineResponse)
newLive   = newSplit.rollup()

For each (scope, jurisdiction, taxType) key in the union of prior and new:
  delta = new - prior
  if delta != 0:
    emit a delta row with amountCents=delta, origin={ kind: 'revision', revisionId }
```

Address changes are revisions with new jurisdictions appearing and old ones zeroing out. The delta naturally falls out of the diff.

### 7.5 Void

```
VoidEvent
For each row in the live ledger:
  emit a delta row with amountCents = -row.amountCents
Sum of live ledger after void must be 0.
```

### 7.6 Largest-remainder allocation

The whole thing rests on this primitive:

```
allocate(totalCents: number, weightsByRow: Record<string, Decimal>): Record<string, number>
```

Distributes `totalCents` across rows according to their weights such that:
1. Every output is an integer (no fractional cents).
2. `sum(output) === totalCents` exactly.
3. The rounding error vs. exact proportional allocation is minimized (Hamilton's method).

Pseudocode:
```
floors = { id: floor(totalCents * weight[id] / sum(weights)) for each row }
allocated = sum(floors.values())
residual = totalCents - allocated   // small non-negative integer
remainders = { id: (totalCents * weight[id] / sum(weights)) - floors[id] for each row }
sort row ids by remainder desc; deterministic tiebreak by row id asc
distribute residual extra cents one-by-one to the top `residual` rows
return floors with residual additions
```

Property-test: for any random `totalCents` (within int range) and any random `weights`, `sum(allocate(...)) === totalCents`. Run 10k cases per commit.

---

## 8. Schema

### 8.1 Logical row (in-memory and in JSON)

Already defined in §5.1.2. The DB row is a 1:1 projection.

### 8.2 Postgres schema (`@tax-ledger/postgres`)

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tax_ledger_rows (
  id                  UUID PRIMARY KEY,                      -- uuidv7 from core
  order_id            TEXT NOT NULL,
  currency            CHAR(3) NOT NULL,

  scope_kind          TEXT NOT NULL CHECK (scope_kind IN ('line','fee','order')),
  scope_ref           TEXT,                                  -- lineItemId | feeKind | NULL
  scope_reason        TEXT,                                  -- only set when scope_kind='order'

  jurisdiction_type   TEXT NOT NULL,                         -- state | county | city | special | country
  jurisdiction_code   TEXT NOT NULL,
  tax_type            TEXT NOT NULL CHECK (tax_type IN ('sales','shipping','bottle_deposit','additional')),

  amount_cents        BIGINT NOT NULL,                       -- signed; negative for deltas

  origin_kind         TEXT NOT NULL CHECK (origin_kind IN ('split','refund','capture','revision','void')),
  origin_ref          TEXT NOT NULL,                         -- engineRef | refundId | …

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tax_ledger_rows_order_idx ON tax_ledger_rows (order_id, created_at);
CREATE INDEX tax_ledger_rows_rollup_idx ON tax_ledger_rows (order_id, scope_kind, scope_ref, jurisdiction_type, jurisdiction_code, tax_type);
CREATE INDEX tax_ledger_rows_origin_idx ON tax_ledger_rows (origin_kind, origin_ref);

-- Optional: a materialized view for the rollup.
-- Refresh on append; consumers query the view for accounting exports.
CREATE MATERIALIZED VIEW tax_ledger_rollup AS
SELECT
  order_id, scope_kind, scope_ref, jurisdiction_type, jurisdiction_code, tax_type,
  SUM(amount_cents)::BIGINT AS net_cents
FROM tax_ledger_rows
GROUP BY 1,2,3,4,5,6;
CREATE UNIQUE INDEX tax_ledger_rollup_pk
  ON tax_ledger_rollup (order_id, scope_kind, scope_ref, jurisdiction_type, jurisdiction_code, tax_type);
```

Notes:
- **No `UPDATE`s, no `DELETE`s in normal operation.** The ledger is append-only. Corrections are new rows. Soft-delete an entire order with a `VoidEvent`, never `DELETE FROM tax_ledger_rows`.
- `scope_ref` is nullable only when `scope_kind = 'order'` (the rounding-residual case).
- `amount_cents` is `BIGINT` because while individual rows are small, a multi-million-row partitioned table could overflow `INTEGER` on `SUM()` aggregates.

---

## 9. Test strategy

### 9.1 Property-based (the headline tests)

Run on every commit with a budget of 1000 cases per property, plus a nightly 10k-case run in CI.

| Property | Statement |
|---|---|
| **Sum-equals-total** | For any valid `LedgerInput`, `sum(split(input).rows.amountCents)` equals `input.totalTaxCents + sum(input.lines.flatMap(l => l.deposits).amountCents)`, with at most a single 1-cent rounding-residual row to account for engine drift. |
| **Refund-deltas-sum** | For any ledger and any refund event, `sum(reconcile(ledger, refund).rows.amountCents)` equals the negative of the buyer-facing refundable tax computed independently by the test (ratio of refunded line/fee value to remaining line/fee value, then summed over the affected rows, with the same allocator). |
| **Idempotent reconcile** | `reconcile(ledger, event)` produces the same row ids and amounts on repeated invocation (with the same event id). The reconciler must be a function of `(ledger, event)` with no hidden state. |
| **Replay equivalence** | For any sequence of refund/capture/revise events, applying them in order to a ledger produces the same `rollup()` as feeding the equivalent final-state engine response through `split()` alone. (Subject to legitimate sequencing-dependent rounding: tolerance is 0 cents for full-quantity refunds, ≤1 cent in aggregate for chained partials.) |
| **Allocator-sums** | For any `totalCents` ∈ [0, 2³¹) and any positive-weight map, `sum(allocate(totalCents, weights)) === totalCents` and every output is a non-negative integer. |
| **Void-zeroes** | After applying a `VoidEvent`, `sum(live.rows.amountCents) === 0` for every taxType and jurisdiction. |
| **Monotone refund** | You cannot refund more from a line than its current remaining net. The reconciler throws `OverRefundError` instead of producing a delta that would make a row negative beyond zero. |

### 9.2 Snapshot / fixture tests

Real, redacted responses from Avalara / TaxJar / Stripe Tax in `__fixtures__/`. The adapter pipes them through `toLedgerInput → split → rollup → JSON` and we snapshot the rollup. Adapter changes that don't change semantics produce identical snapshots.

### 9.3 Adapter contract tests

Each `sources-*` package has a contract test suite that imports the same fixture set (engine-independent shape descriptors) and validates the resulting `LedgerInput` is canonical. Adding a new engine means satisfying these contract tests.

### 9.4 Postgres adapter

Testcontainers PG 16. Round-trip every fixture: persist → load → assert deep-equal. Append-only enforcement test (DELETE / UPDATE on the table should be blocked by a deny-all RLS policy, optionally enabled).

### 9.5 NestJS adapter

Standard `Test.createTestingModule()` with an in-memory ledger repo. Verifies DI wiring and the public service surface, no engine calls.

### 9.6 CI matrix

- Node 20 LTS + Node 22.
- Lint + typecheck + unit + property (1000 cases) on every PR.
- Property (10k cases) + testcontainers integration nightly.
- No live tax-engine calls in CI. Adapter tests run against committed fixtures.

---

## 10. Build phases

| Phase | Scope | Effort |
|---|---|---|
| **0** | Workspace scaffold: pnpm + Turborepo, tsconfig + tsup + Vitest + fast-check + ESLint, MIT, README skeleton, Changesets, CI lint+typecheck+test, repo on GitHub | 2 evenings |
| **1** | `@tax-ledger/core`: `LedgerInput` zod schema, `money.ts` Decimal helpers, `allocator.ts` largest-remainder with property tests, `split()` + `invariants()` with property tests over generated inputs | 3 evenings |
| **2** | Core reconciler: `RefundEvent` + `VoidEvent` + their property tests (sum-equals-refund, idempotent, monotone). The hard ones. | 3 evenings |
| **3** | `CaptureEvent` + `ReviseEvent` + replay-equivalence property test. Address-change as a revision sub-case. | 2 evenings |
| **4** | `@tax-ledger/sources-avalara` adapter with redacted real fixtures; snapshot tests; thorough README walk-through (the worked example from §2) | 2 evenings |
| **5** | `@tax-ledger/sources-taxjar` + `@tax-ledger/sources-stripe-tax` adapters; shared contract-test harness | 2 evenings |
| **6** | `@tax-ledger/postgres` adapter: Drizzle schema, repo, migrations, testcontainers integration tests, rollup materialized view | 2 evenings |
| **7** | `@tax-ledger/nestjs` module + `@tax-ledger/cli` (`reconcile`, `audit`); `examples/basic/` end-to-end; publish v0.1.0 via Changesets | 2 evenings |

**Total v1:** ~18 evenings. 5-7 weeks at a sustainable cadence. Phases 1-3 are the load-bearing ones; everything else is shape.

---

## 11. Decisions to confirm before Phase 0

| # | Decision | Recommended default | Alternative |
|---|---|---|---|
| 1 | npm scope | **`@tax-ledger/*`** (org-style, matches `@temporal-stripe/*` and `@webhook-gateway/*`) | `@mateokadiu/tax-ledger-*` or unscoped `tax-ledger` |
| 2 | Single package vs monorepo | **Monorepo** — core / sources-* / postgres / nestjs / cli have very different dependency surfaces; consumers should be able to install `@tax-ledger/core` standalone with zero adapter weight | Single package; rely on tree-shaking |
| 3 | Money primitive | **`decimal.js`** for math, integer cents for storage and APIs | `dinero.js` (heavier, locale-aware — unneeded here); BigInt cents-only (footgun on rates with >2 decimal places like 0.34375% NY commuter tax) |
| 4 | Engine response — do we own the type? | **No — adapters consume the engine's own SDK types** (Avalara `TransactionModel`, Stripe `Stripe.Tax.Calculation`, etc.). Core only sees `LedgerInput`. | Ship our own typed engine responses; depends on engine SDKs being available as peer deps |
| 5 | Persistence default | **None — core is in-memory; `@tax-ledger/postgres` is opt-in** | Ship core with a SQLite default for examples |
| 6 | Tax type taxonomy | **Four canonical: `sales`, `shipping`, `bottle_deposit`, `additional`** + an open `taxTypeExtensions` registry for consumers to add more (e.g. `excise`, `surtax`) | Closed enum — simpler, less flexible |
| 7 | Rounding residual policy | **Absorb single-cent engine drift into a `scope=order, reason='rounding_residual'` row; throw above 1 cent** | Always throw; or always silently absorb |
| 8 | Refund interface — quantity vs amount | **Both — caller chooses per-line.** Quantity is preferred where the line is unit-priced; amount is allowed for partial-refund use cases (price adjustments) | Quantity-only (forces caller to compute amount mode upstream) |
| 9 | Idempotency key | **`reconcileEvent.id` (refundId / captureId / revisionId / voidId) is the idempotency key.** The same event id replayed against the same ledger yields the same rows (same uuidv7 ids, deterministically derived from `hash(event.id + position)`) | Generate fresh ids; let the caller dedupe |
| 10 | License | **MIT** | Apache-2.0 |
| 11 | Repo location | `~/Desktop/development/personal/tax-ledger/` (folder already exists, empty) | other |
| 12 | Initial v0.1 scope | **Phases 0-4** — core + Avalara adapter + property tests + CLI. TaxJar / Stripe Tax / Postgres / Nest can ship as v0.2 | Ship all phases at once |

---

## 12. Out of scope (explicit so we don't drift)

- **Not a tax calculator.** No rate tables. No "what's the sales tax in Cook County?". The whole library refuses to even ask. Avalara / TaxJar / Stripe Tax are the input.
- **No nexus determination.** That's a compliance-firm problem.
- **No jurisdiction inference from addresses.** The engine response already carries the jurisdictions. We propagate them.
- **No exemption certificates / customer tax IDs.** Upstream concern.
- **No filing / returns / remittance.** Avalara Returns, TaxJar AutoFile.
- **No multi-currency conversion.** One ledger per order, one currency per order.
- **No subscription billing primitives.** A subscription is a sequence of orders; each one gets its own ledger.
- **No PII handling beyond the engine ref.** The ledger stores order ids and line item ids — the rest is integers and enum strings. Don't put PII in line item ids.
- **No admin UI.** The CLI's `audit` subcommand is the only "view" we ship. UI consumers (admin dashboards, accounting exports) read the rollup and render their own.
- **No real-time event bus.** The reconciler is synchronous. Wire it to your queue / outbox of choice (e.g. `webhook-gateway`).

---

## 13. References

- Avalara AvaTax API — `getTransactionByCode`, `adjustTransaction`, `voidTransaction`: https://developer.avalara.com/api-reference/avatax/rest/v2/
- Avalara — line `details[]` taxType and jurisdictionType fields (the structure the splitter unpacks): https://developer.avalara.com/avatax/dev-guide/transactions/transaction-fields/
- TaxJar — `taxForOrder` response shape, `breakdown.line_items`: https://developer.taxjar.com/api/reference/
- Stripe Tax — `Tax.Calculation` and `tax_breakdown`: https://stripe.com/docs/api/tax/calculations
- IRS — recordkeeping for state and local sales taxes (line-item granularity expectation): https://www.irs.gov/businesses/small-businesses-self-employed/recordkeeping
- AICPA / FASB — ASC 606 implications for line-item revenue and associated tax tracking
- Hamilton's method / largest remainder allocation: https://en.wikipedia.org/wiki/Largest_remainders_method
- Prior art (internal, this library productizes the pattern): `vault/src/modules/orders/services/order.taxes.service.ts` — the in-house ratio-and-floor implementation that this package replaces with a typed, property-tested core.
- Prior art (internal): the `AccelPay → LiquidCommerce` payload parity work — the requirement to split a flat `buyer_tax` into `buyer_sales_tax / buyer_shipping_tax / buyer_bottle_deposits / buyer_additional_tax` is the same shape the ledger exposes.
