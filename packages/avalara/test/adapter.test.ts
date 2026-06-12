import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { split } from '@tax-ledger/core';
import { toTaxInput, AvalaraTransactionModelSchema } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, 'fixtures', name);
const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(fixturePath(name), 'utf8'));

describe('AvalaraTransactionModelSchema', () => {
  it('parses the canonical NY three-line response', () => {
    const raw = loadFixture('ny-three-line.json');
    const parsed = AvalaraTransactionModelSchema.parse(raw);
    expect(parsed.code).toBe('ORDER-AV-001');
    expect(parsed.lines).toHaveLength(3);
    expect(parsed.currencyCode).toBe('USD');
  });

  it('rejects a response missing currencyCode', () => {
    const raw = loadFixture('ny-three-line.json') as Record<string, unknown>;
    delete raw.currencyCode;
    expect(() => AvalaraTransactionModelSchema.parse(raw)).toThrow();
  });

  it('rejects an empty lines array', () => {
    const raw = loadFixture('ny-three-line.json') as Record<string, unknown>;
    raw.lines = [];
    expect(() => AvalaraTransactionModelSchema.parse(raw)).toThrow();
  });
});

describe('toTaxInput()', () => {
  it('maps a canonical Avalara response into a usable TaxInput', () => {
    const input = toTaxInput(loadFixture('ny-three-line.json'));
    expect(input.orderId).toBe('ORDER-AV-001');
    expect(input.engineRef).toBe('ORDER-AV-001');
    expect(input.currency).toBe('USD');
    expect(input.totalTaxCents).toBe(412);
    expect(input.lines).toHaveLength(2);
    expect(input.fees).toHaveLength(1);
  });

  it('splits the bottle deposit detail into the deposits array', () => {
    const input = toTaxInput(loadFixture('ny-three-line.json'));
    const lineA = input.lines.find((l) => l.lineItemId === 'A')!;
    expect(lineA.deposits).toHaveLength(1);
    expect(lineA.deposits?.[0]).toMatchObject({
      jurisdiction: { type: 'state', code: 'NY', country: 'US', name: 'NEW YORK' },
      amountCents: 1000,
    });
    // and the deposit row is NOT in taxes[]
    expect(lineA.taxes).toHaveLength(3);
    expect(lineA.taxes.every((t) => t.amountCents > 0)).toBe(true);
  });

  it('normalizes jurisdictionType casing', () => {
    const input = toTaxInput(loadFixture('ny-three-line.json'));
    const lineA = input.lines.find((l) => l.lineItemId === 'A')!;
    expect(lineA.taxes.map((t) => t.jurisdiction.type).sort()).toEqual([
      'city',
      'county',
      'state',
    ]);
  });

  it('carries the engine taxType + behavior onto every tax row', () => {
    const input = toTaxInput(loadFixture('ny-three-line.json'));
    const lineA = input.lines.find((l) => l.lineItemId === 'A')!;
    const stateSales = lineA.taxes.find((t) => t.jurisdiction.type === 'state')!;
    expect(stateSales.engineTaxType).toBe('Sales');
    expect(stateSales.taxBehavior).toBe('exclusive');
  });

  it('separates fee lines from product lines via ref1', () => {
    const input = toTaxInput(loadFixture('ny-three-line.json'));
    expect(input.fees?.[0]?.feeKind).toBe('shipping');
    expect(input.fees?.[0]?.amountCents).toBe(652);
    expect(input.fees?.[0]?.taxes?.[0]?.taxType).toBe('shipping');
  });

  it('roundtrips through split() — splitter sees no engine drift', () => {
    const input = toTaxInput(loadFixture('ny-three-line.json'));
    const ledger = split(input);
    // 3 sales rows on A + 1 deposit + 3 sales rows on B + 1 shipping fee row = 8.
    expect(ledger.rows).toHaveLength(8);
    expect(ledger.currency).toBe('USD');
    // Sum of tax rows matches engine total exactly (no rounding residual).
    const taxSum = ledger.rows
      .filter((r) => r.taxType !== 'bottle_deposit')
      .reduce((a, r) => a + r.amountCents, 0);
    expect(taxSum).toBe(412);
  });

  it('honors a custom orderId option', () => {
    const input = toTaxInput(loadFixture('ny-three-line.json'), {
      orderId: 'internal_42',
    });
    expect(input.orderId).toBe('internal_42');
    expect(input.engineRef).toBe('ORDER-AV-001');
  });

  it('uppercases a lowercase currencyCode', () => {
    const raw = loadFixture('ny-three-line.json') as Record<string, unknown>;
    raw.currencyCode = 'eur';
    const input = toTaxInput(raw);
    expect(input.currency).toBe('EUR');
  });

  it('respects a feeRefs override', () => {
    const input = toTaxInput(loadFixture('ny-three-line.json'), {
      feeRefs: new Set(['shippingFee', 'B']), // pretend B is a fee
    });
    expect(input.lines).toHaveLength(1); // only A is a product line
    expect(input.fees).toHaveLength(2);
    expect(input.fees?.map((f) => f.feeKind).sort()).toEqual(['B', 'shipping']);
  });

  it('respects a custom depositPredicate', () => {
    const input = toTaxInput(loadFixture('ny-three-line.json'), {
      depositPredicate: () => false, // never classify as a deposit
    });
    const lineA = input.lines.find((l) => l.lineItemId === 'A')!;
    expect(lineA.deposits).toHaveLength(0);
    // BottleDeposit detail becomes an `additional` row instead.
    expect(lineA.taxes.some((t) => t.taxType === 'additional')).toBe(true);
  });

  it('throws on malformed inputs', () => {
    expect(() => toTaxInput({ not: 'an avalara response' })).toThrow();
    expect(() => toTaxInput(null)).toThrow();
  });
});
