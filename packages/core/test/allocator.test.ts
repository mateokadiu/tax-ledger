import { describe, it, expect } from 'vitest';
import { allocate } from '../src/allocator.js';
import { dec } from '../src/money.js';
import { AllocationError } from '../src/errors.js';

describe('allocate()', () => {
  it('returns zeroes when total is zero', () => {
    const out = allocate(0, [
      { key: 'a', weight: dec(1) },
      { key: 'b', weight: dec(2) },
    ]);
    expect(out.get('a')).toBe(0);
    expect(out.get('b')).toBe(0);
  });

  it('splits evenly when weights are equal', () => {
    const out = allocate(100, [
      { key: 'a', weight: dec(1) },
      { key: 'b', weight: dec(1) },
    ]);
    expect(out.get('a')).toBe(50);
    expect(out.get('b')).toBe(50);
  });

  it('sums back to total exactly with fractional cents (largest-remainder)', () => {
    // 100 cents over 3 equal weights: 33.33... each. floors = 33,33,33. residual = 1.
    const out = allocate(100, [
      { key: 'a', weight: dec(1) },
      { key: 'b', weight: dec(1) },
      { key: 'c', weight: dec(1) },
    ]);
    const sum = [...out.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
    // Deterministic tiebreak by key asc — extra cent goes to 'a'
    expect(out.get('a')).toBe(34);
    expect(out.get('b')).toBe(33);
    expect(out.get('c')).toBe(33);
  });

  it('respects weight magnitudes', () => {
    const out = allocate(231, [
      { key: 'state', weight: dec(150) },
      { key: 'county', weight: dec(45) },
      { key: 'city', weight: dec(36) },
    ]);
    expect([...out.values()].reduce((a, b) => a + b, 0)).toBe(231);
    // each weight's share is itself, so output should equal the weight
    expect(out.get('state')).toBe(150);
    expect(out.get('county')).toBe(45);
    expect(out.get('city')).toBe(36);
  });

  it('handles negative totals with consistent signs', () => {
    const out = allocate(-100, [
      { key: 'a', weight: dec(1) },
      { key: 'b', weight: dec(1) },
      { key: 'c', weight: dec(1) },
    ]);
    expect([...out.values()].reduce((a, b) => a + b, 0)).toBe(-100);
    expect(out.get('a')).toBe(-34);
    expect(out.get('b')).toBe(-33);
    expect(out.get('c')).toBe(-33);
  });

  it('throws when total is non-zero but all weights are zero', () => {
    expect(() =>
      allocate(100, [
        { key: 'a', weight: dec(0) },
        { key: 'b', weight: dec(0) },
      ]),
    ).toThrow(AllocationError);
  });

  it('throws on non-integer total', () => {
    expect(() => allocate(1.5, [{ key: 'a', weight: dec(1) }])).toThrow(AllocationError);
  });
});
