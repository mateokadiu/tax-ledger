import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { allocate } from '../../src/allocator.js';
import { dec } from '../../src/money.js';

describe('property: allocate() invariants', () => {
  it('sum(output) === totalCents for any positive total and positive weights (1000 runs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 30 }),
        (total, weights) => {
          const items = weights.map((w, i) => ({ key: `k${i}`, weight: dec(w) }));
          const out = allocate(total, items);
          const sum = [...out.values()].reduce((a, b) => a + b, 0);
          return sum === total;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('every output is a non-negative integer when total is non-negative (1000 runs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(fc.integer({ min: 1, max: 100_000 }), { minLength: 1, maxLength: 20 }),
        (total, weights) => {
          const items = weights.map((w, i) => ({ key: `k${i}`, weight: dec(w) }));
          const out = allocate(total, items);
          return [...out.values()].every((v) => Number.isInteger(v) && v >= 0);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('sum(output) === totalCents for negative totals (deltas) too (1000 runs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_000, max: -1 }),
        fc.array(fc.integer({ min: 1, max: 100_000 }), { minLength: 1, maxLength: 20 }),
        (total, weights) => {
          const items = weights.map((w, i) => ({ key: `k${i}`, weight: dec(w) }));
          const out = allocate(total, items);
          return [...out.values()].reduce((a, b) => a + b, 0) === total;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('allocator is deterministic — same input, same output (200 runs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 2, maxLength: 10 }),
        (total, weights) => {
          const items = weights.map((w, i) => ({ key: `k${i}`, weight: dec(w) }));
          const a = allocate(total, items);
          const b = allocate(total, items);
          return [...a.entries()].every(([k, v]) => b.get(k) === v);
        },
      ),
      { numRuns: 200 },
    );
  });
});
