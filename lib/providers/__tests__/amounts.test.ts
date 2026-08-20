import { describe, expect, it } from 'vitest';
import {
  readNumber,
  resolveVatTriple,
  sumLineVat,
  lineVatFromPercent,
  multiplyIfBothPresent,
} from '../amounts';

describe('readNumber', () => {
  it('returns the first present candidate, in order', () => {
    expect(readNumber({ b: 2, a: 1 }, ['a', 'b'])).toBe(1);
    expect(readNumber({ b: 2 }, ['a', 'b'])).toBe(2);
  });

  it('distinguishes an absent field from a zero one', () => {
    expect(readNumber({ Net: 0 }, ['Net'])).toBe(0);
    expect(readNumber({}, ['Net'])).toBeUndefined();
  });

  it('coerces string-serialised decimals', () => {
    expect(readNumber({ net_amount: '1476.00' }, ['net_amount'])).toBe(1476);
  });

  it('skips nulls, empty strings and non-numerics rather than reading them as 0', () => {
    expect(readNumber({ a: null, b: '', c: 'n/a', d: 5 }, ['a', 'b', 'c', 'd'])).toBe(5);
    expect(readNumber({ a: null }, ['a'])).toBeUndefined();
  });

  it('tolerates a missing payload', () => {
    expect(readNumber(undefined, ['a'])).toBeUndefined();
  });
});

describe('resolveVatTriple', () => {
  it('completes VAT from a stated net', () => {
    expect(resolveVatTriple({ gross: 1845000, net: 1476000 }))
      .toEqual({ net: 1476000, vat: 369000 });
  });

  it('completes the net from a stated VAT', () => {
    expect(resolveVatTriple({ gross: 1845000, vat: 369000 }))
      .toEqual({ net: 1476000, vat: 369000 });
  });

  it('passes both through when both are stated', () => {
    expect(resolveVatTriple({ gross: 100, net: 80, vat: 20 }))
      .toEqual({ net: 80, vat: 20 });
  });

  it('resolves NOTHING from a gross alone', () => {
    // The regression this whole module exists for: with only the payable
    // amount known, net = gross and VAT = 0 is an invention, not a default.
    expect(resolveVatTriple({ gross: 1845000 })).toEqual({});
  });

  it('treats a genuine zero VAT as an answer, not as absence', () => {
    expect(resolveVatTriple({ gross: 1000, vat: 0 })).toEqual({ net: 1000, vat: 0 });
  });
});

describe('sumLineVat', () => {
  it('sums when every line carries an amount', () => {
    expect(sumLineVat([
      { taxAmount: { value: 250 } },
      { taxAmount: { value: 60 } },
    ])).toBe(310);
  });

  it('refuses a partial sum when any line is missing its VAT', () => {
    expect(sumLineVat([
      { taxAmount: { value: 250 } },
      {},
    ])).toBeUndefined();
  });

  it('returns undefined for no lines', () => {
    expect(sumLineVat([])).toBeUndefined();
  });
});

describe('lineVatFromPercent', () => {
  it('accepts both unit conventions', () => {
    expect(lineVatFromPercent(1000, 25)).toBe(250);
    expect(lineVatFromPercent(1000, 0.25)).toBe(250);
  });

  it('computes 0 for a stated 0 % rate', () => {
    expect(lineVatFromPercent(1000, 0)).toBe(0);
  });

  it('returns undefined for an unstated rate rather than assuming one', () => {
    expect(lineVatFromPercent(1000, undefined)).toBeUndefined();
  });

  it('rounds to öre without toFixed drift', () => {
    expect(lineVatFromPercent(333.33, 25)).toBe(83.33);
  });
});

describe('multiplyIfBothPresent', () => {
  it('multiplies when both factors are known', () => {
    expect(multiplyIfBothPresent(100, 3)).toBe(300);
  });

  it('returns undefined when either factor is missing', () => {
    expect(multiplyIfBothPresent(100, undefined)).toBeUndefined();
    expect(multiplyIfBothPresent(undefined, 3)).toBeUndefined();
  });
});
