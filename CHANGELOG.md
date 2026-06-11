# changelog

## 1.1.0 — unreleased

Correctness + reconciliation pass. Quantity refunds actually work, the pipeline
is deterministic, the model carries enough engine metadata to reconcile, and the
ledger gained the reporting/reconcile verbs real systems need.

### added

- **Quantity-based refunds.** `refund(ledger, { lines: [{ lineItemId, quantity }] })` now recovers the line's remaining units from the ledger and removes a proportional slice. Previously `computeRemainingQuantity` was a stub that returned `1`, so a quantity refund either threw or silently refunded the whole line.
- **Deterministic, replayable output.** `split` / `refund` / `revise` / `partialCapture` accept an options bag `{ now?, generateId? }`. Pass deterministic implementations for snapshot tests or event-sourced replays; omit for the default real clock + UUIDv7.
- **`'vat'` tax type** plus optional `taxCode`, `taxBehavior` (`inclusive` | `exclusive`), and `engineTaxType` (the engine's native label) on both `LineItemTax` (input) and `LedgerEntry` (output). These flow through `split`/`refund`/`revise`/`partialCapture` and are persisted by the Drizzle adapter.
- **`reconcile(ledger, delta, { expectTotalCents?, toleranceCents? })`** — fold an engine-provided refund/reversal/return into the ledger and assert it sums to what the engine reported (within tolerance), catching drift. Production tax engines (Stripe Tax reversals, Avalara refund/adjust) re-quote refund tax; this is the verb that records and verifies that authoritative delta locally.
- **Reporting helpers on `Ledger`:** `toComponentTotals()` → `{ salesTax, shippingTax, bottleDeposits, vat, additional, total }` (the canonical components a buyer-tax payload needs), and `rollupBy([...])` to group/sum by `taxType` / `jurisdictionType` / `jurisdictionCode` / `scope` / `origin` / `currency`.
- Drizzle PG + SQLite schemas and the migration generator now persist `tax_code`, `tax_behavior`, `engine_tax_type`, and `quantity` (all nullable).

### changed

- **Stripe Tax adapter** maps the value-added family (`vat` / `gst` / `hst` / `igst` / `jct` / `pst` / `qst`) to `taxType: 'vat'` instead of collapsing to `additional`, and carries each line's `tax_code` + `tax_behavior` and the breakdown's native `tax_type`.
- **Avalara adapter** detects real Avalara `Bottle` deposits (the default predicate previously only matched `BottleDeposit` / "container deposit"), maps Avalara `Input` / `Output` / VAT tax types to `'vat'`, and carries each line's `taxCode` + `taxIncluded` behavior + native taxType.
- Residual-cent placement in `refund`/`partialCapture` now breaks remainder ties on stable row position rather than the (random) row id, so the same input allocates identically across runs.
- Adapter + drizzle `test` scripts no longer pass `--passWithNoTests` (every package has real tests).
- `pnpm test` now runs 128 tests across the 5 packages.

### fixed

- Quantity-based refunds (see above) — the headline lifecycle feature was non-functional in 1.0.0.
- Allocation is now genuinely replay-stable; the previous tiebreak depended on non-deterministic UUID ordering.

## 1.0.0 — 2026-07-04

First stable release. Engine adapters, persistence, and multi-currency are in.

### added

- `@tax-ledger/avalara` — adapter for Avalara's `CreateTransactionModel` response. Reads `lines[].details[]` plus per-jurisdiction breakdown into a normalized `TaxInput`. Zod schema mirrors the public response shape; `passthrough()` keeps unknown engine fields from breaking callers.
- `@tax-ledger/taxjar` — adapter for the `POST /v2/taxes` flat response. Per-line `state_amount`/`county_amount`/`city_amount`/`special_district_amount` are projected into separate `LineItemTax` rows. Handles exempt items, free shipping, and lines TaxJar omits from `breakdown.line_items`.
- `@tax-ledger/stripe-tax` — adapter for `Tax.Calculation` objects. Maps `line_items[].tax_breakdown[]` into the engine-agnostic shape; supports both the wrapped-list and bare-array `line_items` forms; classifies `vat`/`gst`/`hst` as `additional`.
- `@tax-ledger/drizzle` — opinionated PG + SQLite-compatible Drizzle schema for `tax_ledger_entries` and `tax_ledger_deltas`. `persistLedger(db, ledger)` writes a whole split, `applyDelta(db, originalId, delta)` writes deltas plus cross-reference links. `generateMigration('pg' | 'sqlite')` emits raw DDL for either dialect.
- Multi-currency in core. `TaxInput.currency` is an ISO-4217 code (three uppercase letters, Zod-validated). `Ledger.with()` and `revise()` refuse cross-currency operations with `CurrencyMismatchError`.
- `TaxInput` is now the canonical name for the input shape. `OrderInput` remains as an alias.

### changed

- `Ledger` now carries `currency: CurrencyCode` (was: `string`).
- Existing fixtures and tests in `@tax-ledger/core` keep working without changes.
- `pnpm test` now runs 110 tests across 5 packages (up from 54 in core alone).

### roadmap

- `@tax-ledger/nestjs` — DI-friendly module.
- `@tax-ledger/cli` — `reconcile <file>` / `audit <db>`.
- Materialized rollup view in the Drizzle schema.
- `VoidEvent` + `AddressChangeEvent` as first-class reconcile inputs.

## 0.1.0 — 2026-06-15

Initial release of `@tax-ledger/core`.

### added

- `split()`, `refund()`, `partialCapture()`, `revise()` — pure functions, append-only ledger output.
- Largest-remainder (Hamilton's) allocator with `decimal.js` intermediate math. Sum-preserving by construction.
- Zod-validated input boundary.
- 54 tests, including 21 property-based tests (fast-check, 500-1000 runs each) covering sum-equals-total, refund-sums-back, no-fractional-cents, idempotent-reconcile, and no-collapse-jurisdiction invariants.
- `examples/basic` — Avalara-shaped order through the full lifecycle.
