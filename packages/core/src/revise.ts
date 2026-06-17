import { uuidv7 } from './ids.js';
import {
  ReviseSpecSchema,
  type LedgerEntry,
  type LedgerOrigin,
  type ReviseSpec,
  type TaxType,
} from './types.js';
import { CurrencyMismatchError } from './errors.js';
import { split } from './split.js';
import type { Ledger } from './ledger.js';

/**
 * Rollup key shape: `<scope>|<jurisdiction>|<taxType>`. Stable across
 * insertion order; collisions only happen when two rows belong to the
 * same logical bucket (which is exactly what we want for the diff).
 */
function keyOf(r: { scope: LedgerEntry['scope']; jurisdiction: LedgerEntry['jurisdiction']; taxType: TaxType }): string {
  let scopeKey: string;
  switch (r.scope.kind) {
    case 'line':
      scopeKey = `line:${r.scope.lineItemId}`;
      break;
    case 'fee':
      scopeKey = `fee:${r.scope.feeKind}`;
      break;
    case 'order':
      scopeKey = `order:${r.scope.reason}`;
      break;
  }
  return `${scopeKey}|${r.jurisdiction.type}:${r.jurisdiction.code}|${r.taxType}`;
}

/**
 * Order revision: the merchant changes the order (line removed, item swap,
 * address change). The engine returns a fresh response; we split it, diff
 * the resulting rollup against the live ledger's rollup, and emit one delta
 * row per non-zero (scope, jurisdiction, taxType) difference.
 *
 *   delta = new - prior   (signed)
 *
 * Lines removed entirely from newOrder get negative deltas equal to their
 * current net. New lines appear as positive deltas. Address changes look
 * like: old-jurisdiction zeroes out, new-jurisdiction appears.
 */
export function revise(ledger: Ledger, spec: ReviseSpec): LedgerEntry[] {
  const parsed = ReviseSpecSchema.parse(spec);
  if (parsed.newOrder.currency !== ledger.currency) {
    throw new CurrencyMismatchError(
      `revise: new order in ${parsed.newOrder.currency} cannot reconcile against ledger in ${ledger.currency}`,
      { expected: ledger.currency, actual: parsed.newOrder.currency },
    );
  }
  const origin: LedgerOrigin = { kind: 'revision', revisionId: parsed.revisionId };
  const createdAt = new Date().toISOString();

  // Build the prior rollup from the live ledger.
  const priorRollup = new Map<string, { net: number; row: LedgerEntry }>();
  for (const r of ledger.rows) {
    const k = keyOf(r);
    const existing = priorRollup.get(k);
    if (existing) {
      existing.net += r.amountCents;
    } else {
      priorRollup.set(k, { net: r.amountCents, row: r });
    }
  }

  // Build the new rollup from a fresh split of newOrder.
  const newLedger = split(parsed.newOrder);
  const newRollup = new Map<string, { net: number; row: LedgerEntry }>();
  for (const r of newLedger.rows) {
    const k = keyOf(r);
    const existing = newRollup.get(k);
    if (existing) {
      existing.net += r.amountCents;
    } else {
      newRollup.set(k, { net: r.amountCents, row: r });
    }
  }

  const out: LedgerEntry[] = [];
  const seen = new Set<string>();

  // 1) keys in new (possibly also in prior) → delta = new - prior
  for (const [k, v] of newRollup) {
    seen.add(k);
    const priorNet = priorRollup.get(k)?.net ?? 0;
    const delta = v.net - priorNet;
    if (delta === 0) continue;
    out.push({
      id: uuidv7(),
      orderId: ledger.orderId,
      currency: ledger.currency,
      scope: v.row.scope,
      jurisdiction: v.row.jurisdiction,
      taxType: v.row.taxType,
      amountCents: delta,
      origin,
      createdAt,
    });
  }

  // 2) keys only in prior → delta = 0 - prior = -prior
  for (const [k, v] of priorRollup) {
    if (seen.has(k)) continue;
    if (v.net === 0) continue;
    out.push({
      id: uuidv7(),
      orderId: ledger.orderId,
      currency: ledger.currency,
      scope: v.row.scope,
      jurisdiction: v.row.jurisdiction,
      taxType: v.row.taxType,
      amountCents: -v.net,
      origin,
      createdAt,
    });
  }

  return out;
}

// Exported for tests that want to inspect the rollup key generator.
export const __test = { keyOf };
