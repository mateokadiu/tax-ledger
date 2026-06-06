# changelog

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
