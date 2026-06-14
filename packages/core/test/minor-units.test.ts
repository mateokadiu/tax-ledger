import { describe, it, expect } from 'vitest';
import { minorUnitExponent, toMinorUnits, fromMinorUnits, formatMinorUnits } from '../src/index.js';

describe('currency minor units', () => {
  it('knows common exponents (case-insensitive, defaulting to 2)', () => {
    expect(minorUnitExponent('USD')).toBe(2);
    expect(minorUnitExponent('eur')).toBe(2);
    expect(minorUnitExponent('JPY')).toBe(0);
    expect(minorUnitExponent('KWD')).toBe(3);
    expect(minorUnitExponent('XYZ')).toBe(2);
  });

  it('converts major → minor across exponents', () => {
    expect(toMinorUnits(12.34, 'USD')).toBe(1234);
    expect(toMinorUnits(1000, 'JPY')).toBe(1000);
    expect(toMinorUnits(1.234, 'KWD')).toBe(1234);
  });

  it('round-trips minor → major', () => {
    expect(fromMinorUnits(1234, 'USD')).toBe(12.34);
    expect(fromMinorUnits(1000, 'JPY')).toBe(1000);
    expect(fromMinorUnits(1234, 'KWD')).toBe(1.234);
  });

  it('formats with the right number of decimals', () => {
    expect(formatMinorUnits(1234, 'USD')).toBe('12.34');
    expect(formatMinorUnits(1000, 'JPY')).toBe('1000');
    expect(formatMinorUnits(1234, 'KWD')).toBe('1.234');
  });

  it('uses banker\'s rounding on the half-cent boundary', () => {
    expect(toMinorUnits('2.345', 'USD')).toBe(234); // 234.5 → nearest even
    expect(toMinorUnits('2.355', 'USD')).toBe(236); // 235.5 → nearest even
  });
});
