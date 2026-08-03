import { describe, it, expect } from 'vitest'
import {
  LEGAL_VAT_RATES,
  isLegalVatRate,
  normalizeVatRateToFraction,
  normalizeVatRateToDecimal,
  findIllegalVatRateRow,
  findReverseChargeAccountWarningRows,
  findUnflaggedForeignZeroVatRows,
} from '@/lib/vat/supplier-invoice-line-checks'

describe('LEGAL_VAT_RATES', () => {
  it('is exactly the legal Swedish set as decimal fractions', () => {
    expect(LEGAL_VAT_RATES).toEqual([0.25, 0.12, 0.06, 0])
  })
})

describe('isLegalVatRate', () => {
  it.each([0.25, 0.12, 0.06, 0])('accepts %s', (rate) => {
    expect(isLegalVatRate(rate)).toBe(true)
  })

  it.each([0.13, 0.17, 0.2, 0.1, 1, -0.25])('rejects %s', (rate) => {
    expect(isLegalVatRate(rate)).toBe(false)
  })

  it('accepts a rate produced the way the form parses free text (typing 12 -> 12/100)', () => {
    // VatRateCell stores parsed-percent / 100; the division must land exactly
    // on the preset double for the strict includes() match to hold.
    expect(isLegalVatRate(12 / 100)).toBe(true)
    expect(isLegalVatRate(6 / 100)).toBe(true)
    expect(isLegalVatRate(25 / 100)).toBe(true)
  })
})

describe('normalizeVatRateToDecimal', () => {
  it.each([
    [25, 0.25],
    [12, 0.12],
    [6, 0.06],
  ])('converts percent-integer %s to decimal %s', (percent, decimal) => {
    expect(normalizeVatRateToDecimal(percent)).toBe(decimal)
  })

  it.each([0, 0.06, 0.12, 0.25])('passes already-decimal %s through unchanged', (rate) => {
    expect(normalizeVatRateToDecimal(rate)).toBe(rate)
  })

  it.each([19, 20, 0.19, 0.2, 1, 100, -0.25, -25])(
    'maps non-statutory rate %s to 0 (strict Swedish allowlist)',
    (rate) => {
      expect(normalizeVatRateToDecimal(rate)).toBe(0)
    },
  )

  it('maps missing or non-finite input to 0', () => {
    expect(normalizeVatRateToDecimal(null)).toBe(0)
    expect(normalizeVatRateToDecimal(undefined)).toBe(0)
    expect(normalizeVatRateToDecimal(Number.NaN)).toBe(0)
    expect(normalizeVatRateToDecimal(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('normalizeVatRateToFraction', () => {
  it.each([
    [25, 0.25],
    [19, 0.19],
    [12, 0.12],
    [6, 0.06],
    [100, 1],
  ])('converts percent-shaped %s to fraction %s', (percent, fraction) => {
    expect(normalizeVatRateToFraction(percent)).toBe(fraction)
  })

  it.each([0, 0.06, 0.12, 0.19, 0.24995, 0.25, 1])(
    'preserves already-fractional %s',
    (rate) => {
      expect(normalizeVatRateToFraction(rate)).toBe(rate)
    },
  )

  it.each([-25, -0.25, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    'maps out-of-range value %s to 0',
    (rate) => {
      expect(normalizeVatRateToFraction(rate)).toBe(0)
    },
  )

  it('maps missing input to 0', () => {
    expect(normalizeVatRateToFraction(null)).toBe(0)
    expect(normalizeVatRateToFraction(undefined)).toBe(0)
  })
})

describe('findIllegalVatRateRow', () => {
  it('returns -1 when every line is legal', () => {
    const items = [{ vat_rate: 0.25 }, { vat_rate: 0.12 }, { vat_rate: 0 }]
    expect(findIllegalVatRateRow(items)).toBe(-1)
  })

  it('returns -1 for an empty list', () => {
    expect(findIllegalVatRateRow([])).toBe(-1)
  })

  it('returns the index of the first illegal line', () => {
    const items = [{ vat_rate: 0.25 }, { vat_rate: 0.13 }, { vat_rate: 0.17 }]
    expect(findIllegalVatRateRow(items)).toBe(1)
  })

  it('flags a 13 % rate typed into the free-text cell (13 / 100)', () => {
    expect(findIllegalVatRateRow([{ vat_rate: 13 / 100 }])).toBe(0)
  })
})

describe('findReverseChargeAccountWarningRows', () => {
  it('flags class 1 and class 6 accounts', () => {
    const items = [
      { account_number: '1930' },
      { account_number: '4010' },
      { account_number: '6540' },
    ]
    expect(findReverseChargeAccountWarningRows(items)).toEqual([0, 2])
  })

  it('does not flag the expected 4xxx/5xxx cost accounts', () => {
    const items = [{ account_number: '4515' }, { account_number: '5420' }]
    expect(findReverseChargeAccountWarningRows(items)).toEqual([])
  })

  it('skips rows without an account (owned by the account-missing check)', () => {
    const items = [{ account_number: '' }, { account_number: '1220' }]
    expect(findReverseChargeAccountWarningRows(items)).toEqual([1])
  })

  it('returns an empty list for no items', () => {
    expect(findReverseChargeAccountWarningRows([])).toEqual([])
  })

  it('treats account numbers as strings, not numbers', () => {
    // '16' and '60' start with 1/6 as strings; a numeric range check would
    // classify them differently.
    expect(
      findReverseChargeAccountWarningRows([
        { account_number: '1680' },
        { account_number: '6072' },
        { account_number: '7010' },
      ]),
    ).toEqual([0, 1])
  })
})

describe('findUnflaggedForeignZeroVatRows', () => {
  const zero = [{ vat_rate: 0 }]

  it('flags every 0 % line on an EU supplier invoice with reverse charge off', () => {
    const items = [{ vat_rate: 0 }, { vat_rate: 0.25 }, { vat_rate: 0 }]
    expect(findUnflaggedForeignZeroVatRows(items, false, 'eu_business')).toEqual([0, 2])
  })

  it('flags a 0 % line on a non-EU supplier invoice', () => {
    // The form auto-ticks reverse charge for eu_business but not for
    // non_eu_business, so this is the case that actually slips through.
    expect(findUnflaggedForeignZeroVatRows(zero, false, 'non_eu_business')).toEqual([0])
  })

  it('stays silent for a Swedish supplier at 0 %', () => {
    // Bankavgift, forsakring, hyra: a genuine exemption that belongs in no
    // ruta at all. Flagging it would be noise, not a finding.
    expect(findUnflaggedForeignZeroVatRows(zero, false, 'swedish_business')).toEqual([])
  })

  it('stays silent when reverse charge is already on', () => {
    const items = [{ vat_rate: 0 }, { vat_rate: 0 }]
    expect(findUnflaggedForeignZeroVatRows(items, true, 'eu_business')).toEqual([])
    expect(findUnflaggedForeignZeroVatRows(items, true, 'non_eu_business')).toEqual([])
  })

  it('stays silent before a supplier is picked', () => {
    expect(findUnflaggedForeignZeroVatRows(zero, false, undefined)).toEqual([])
    expect(findUnflaggedForeignZeroVatRows(zero, false, null)).toEqual([])
    expect(findUnflaggedForeignZeroVatRows(zero, false, '')).toEqual([])
  })

  it('stays silent when the foreign supplier charged VAT on every line', () => {
    const items = [{ vat_rate: 0.25 }, { vat_rate: 0.12 }, { vat_rate: 0.06 }]
    expect(findUnflaggedForeignZeroVatRows(items, false, 'eu_business')).toEqual([])
  })

  it('returns an empty list for no items', () => {
    expect(findUnflaggedForeignZeroVatRows([], false, 'eu_business')).toEqual([])
  })

  it('ignores an unknown supplier type rather than guessing it is foreign', () => {
    expect(findUnflaggedForeignZeroVatRows(zero, false, 'private_person')).toEqual([])
  })
})
