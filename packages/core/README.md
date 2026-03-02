# @tax-ledger/core

Pure-TypeScript line-item tax splitter + reconciliation engine. Decimal.js for money math, Zod for runtime input validation, no I/O.

## API surface (v0.1)

```ts
import { split, refund, partialCapture, revise } from '@tax-ledger/core';

const ledger = split(orderInput);            // OrderInput -> Ledger
const deltaA = refund(ledger, refundSpec);   // partial / full refund
const deltaB = partialCapture(ledger, cap);  // capture-less-than-auth
const deltaC = revise(ledger, newOrder);     // line revision / address change

const live = ledger.with(deltaA).with(deltaB);
```

Every function returns *delta* ledger rows. The ledger itself is append-only; consumers materialize the live state by folding deltas in.

## Invariants

- `sum(split(input)) === input.totalTaxCents + sum(deposits)`
- `sum(refund(ledger, spec).rows) === -spec.refundedTaxCents`
- Every emitted `amountCents` is an integer (largest-remainder allocation).
- `reconcile` is a pure function of `(ledger, event)` — replaying the same event produces the same delta.

See repo root `README.md` for the full story and `PLAN.md` for the architecture.
