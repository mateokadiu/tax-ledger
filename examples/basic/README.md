# examples/basic

Runnable end-to-end: takes a mock Avalara response, splits it into a ledger, refunds half of one line, prints the live ledger.

```bash
pnpm install
pnpm --filter @tax-ledger/example-basic start
```

Expected output is a 4-step walkthrough — the input shape, the split rows, the refund delta rows, and the live per-jurisdiction roll-up. The last assertion to eyeball: `sum(delta) == -refundAmount` to the cent.

## The walkthrough

1. **Avalara → OrderInput.** The adapter layer (shipped in v0.2 as `@tax-ledger/sources-avalara`) is inlined here as `toOrderInput()`. It's a shape-mapper — no math.
2. **`split(input)`.** Emits one ledger row per `(line | fee, jurisdiction, taxType)` plus one per deposit. Sums back to `input.totalTaxCents + sum(deposits)` exactly.
3. **`refund(ledger, spec)`.** Returns negative-cent delta rows allocated by largest-remainder so they sum to `-spec.amountCents` exactly.
4. **`ledger.with(delta)`.** Append-only — produces a new live ledger. `netCents(filter)` slices it any way you want.

This is what the equivalent flow looks like in a typical retail codebase today: 500-1000 lines of ad-hoc ratios across services. The point of `@tax-ledger/core` is to make that flow be these ~30 lines.
