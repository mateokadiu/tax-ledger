import { dec, type DecimalLike } from './money.js';
import { AllocationError } from './errors.js';

export interface AllocationItem<K extends string = string> {
  key: K;
  weight: DecimalLike;
}

/**
 * Largest-remainder (Hamilton's) allocation of `totalCents` across items by weight.
 *
 *  - Every output is a signed integer (matches the sign of `totalCents`).
 *  - `sum(output) === totalCents` exactly — no FP drift, no off-by-one.
 *  - Residual cents go to the items with the largest fractional remainders;
 *    deterministic tiebreak by item key (ascending) so replay is stable.
 *
 * If `totalCents === 0`, every output is 0. If all weights are zero but
 * total is non-zero, we throw — there's no defensible way to attribute.
 */
export function allocate<K extends string>(
  totalCents: number,
  items: ReadonlyArray<AllocationItem<K>>,
): Map<K, number> {
  if (!Number.isInteger(totalCents)) {
    throw new AllocationError(`totalCents must be an integer, got ${totalCents}`);
  }
  const out = new Map<K, number>();
  if (items.length === 0) {
    if (totalCents !== 0) {
      throw new AllocationError(`cannot allocate ${totalCents} cents over zero items`);
    }
    return out;
  }
  if (totalCents === 0) {
    for (const it of items) out.set(it.key, 0);
    return out;
  }

  const sign = totalCents < 0 ? -1 : 1;
  const abs = Math.abs(totalCents);

  const sumWeights = items.reduce((acc, it) => acc.plus(it.weight), dec(0));
  if (sumWeights.lte(0)) {
    throw new AllocationError(`cannot allocate ${totalCents} cents — all weights are non-positive`);
  }

  // exact = totalCents * weight / sumWeights, then floor + collect remainder.
  type Row = { key: K; floor: number; rem: DecimalLike };
  const rows: Row[] = items.map((it) => {
    const exact = dec(abs).times(it.weight).div(sumWeights);
    const floor = exact.floor().toNumber();
    const rem = exact.minus(floor);
    return { key: it.key, floor, rem };
  });

  const allocated = rows.reduce((acc, r) => acc + r.floor, 0);
  let residual = abs - allocated;
  if (residual < 0) {
    // floor(x) should never sum above x — defensive only.
    throw new AllocationError(`allocator underflow: residual=${residual}`);
  }

  // Sort by remainder desc, then by key asc for deterministic tiebreak.
  rows.sort((a, b) => {
    const r = b.rem.comparedTo(a.rem);
    if (r !== 0) return r;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  for (const r of rows) {
    if (residual <= 0) break;
    r.floor += 1;
    residual -= 1;
  }

  for (const r of rows) out.set(r.key, r.floor * sign);
  return out;
}
