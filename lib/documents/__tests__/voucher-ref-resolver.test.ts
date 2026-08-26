import { describe, it, expect } from 'vitest'
import {
  buildVoucherIndex,
  candidatesForNumber,
  candidatesForRef,
  periodIdForDate,
  resolveDatedRef,
  sourceVoucherLabel,
  voucherLabel,
  type FiscalPeriodRow,
  type VoucherRow,
} from '@/lib/documents/voucher-ref-resolver'

const PERIOD_2024 = 'period-2024'
const PERIOD_2025 = 'period-2025'

const periods: FiscalPeriodRow[] = [
  {
    id: PERIOD_2024,
    period_start: '2024-01-01',
    period_end: '2024-12-31',
    is_closed: false,
    locked_at: null,
  },
  {
    id: PERIOD_2025,
    period_start: '2025-01-01',
    period_end: '2025-12-31',
    is_closed: false,
    locked_at: null,
  },
]

function makeVoucher(overrides: Partial<VoucherRow> & Pick<VoucherRow, 'id'>): VoucherRow {
  return {
    fiscal_period_id: PERIOD_2024,
    entry_date: '2024-03-14',
    description: 'Import: A31',
    voucher_series: 'A',
    voucher_number: 47,
    source_voucher_series: 'A',
    source_voucher_number: 31,
    ...overrides,
  }
}

describe('buildVoucherIndex', () => {
  it('indexes an entry by both its period key and its source ref', () => {
    const index = buildVoucherIndex([makeVoucher({ id: 'je-1' })])

    expect(index.byPeriodKey.get(`${PERIOD_2024}|A|31`)).toBe('je-1')
    expect(candidatesForRef(index, { series: 'A', number: 31 })).toHaveLength(1)
    expect(index.ambiguousPeriodKeys.size).toBe(0)
  })

  it('skips entries with no source ref (non-SIE and pre-2026-04 imports)', () => {
    const index = buildVoucherIndex([
      makeVoucher({ id: 'je-1', source_voucher_series: null, source_voucher_number: null }),
    ])

    expect(index.byPeriodKey.size).toBe(0)
    expect(index.bySourceRef.size).toBe(0)
    expect(index.byNumber.size).toBe(0)
  })

  it('drops BOTH entries when one source ref repeats inside a fiscal year', () => {
    const index = buildVoucherIndex([
      makeVoucher({ id: 'je-1' }),
      makeVoucher({ id: 'je-2' }),
    ])

    expect(index.byPeriodKey.has(`${PERIOD_2024}|A|31`)).toBe(false)
    expect(index.ambiguousPeriodKeys.has(`${PERIOD_2024}|A|31`)).toBe(true)
    // Both stay discoverable so a caller can present the choice.
    expect(candidatesForRef(index, { series: 'A', number: 31 })).toHaveLength(2)
  })

  it('keeps a third repeat out of byPeriodKey once the key is ambiguous', () => {
    const index = buildVoucherIndex([
      makeVoucher({ id: 'je-1' }),
      makeVoucher({ id: 'je-2' }),
      makeVoucher({ id: 'je-3' }),
    ])

    expect(index.byPeriodKey.has(`${PERIOD_2024}|A|31`)).toBe(false)
    expect(candidatesForRef(index, { series: 'A', number: 31 })).toHaveLength(3)
  })

  it('keeps the same source ref in different fiscal years apart', () => {
    const index = buildVoucherIndex([
      makeVoucher({ id: 'je-2024' }),
      makeVoucher({ id: 'je-2025', fiscal_period_id: PERIOD_2025, entry_date: '2025-03-14' }),
    ])

    expect(index.byPeriodKey.get(`${PERIOD_2024}|A|31`)).toBe('je-2024')
    expect(index.byPeriodKey.get(`${PERIOD_2025}|A|31`)).toBe('je-2025')
    expect(candidatesForRef(index, { series: 'A', number: 31 })).toHaveLength(2)
  })

  it('matches series case-insensitively on both sides', () => {
    const index = buildVoucherIndex([makeVoucher({ id: 'je-1', source_voucher_series: 'a' })])

    expect(candidatesForRef(index, { series: 'A', number: 31 })).toHaveLength(1)
    expect(index.byPeriodKey.get(`${PERIOD_2024}|A|31`)).toBe('je-1')
  })
})

describe('candidatesForNumber', () => {
  it('finds a number across every series', () => {
    const index = buildVoucherIndex([
      makeVoucher({ id: 'je-a', source_voucher_series: 'A' }),
      makeVoucher({ id: 'je-b', source_voucher_series: 'B' }),
    ])

    expect(candidatesForNumber(index, 31).map((v) => v.id)).toEqual(['je-a', 'je-b'])
    expect(candidatesForNumber(index, 999)).toEqual([])
  })
})

describe('periodIdForDate', () => {
  it('finds the period containing the date, inclusive of both bounds', () => {
    expect(periodIdForDate(periods, '2024-01-01')).toBe(PERIOD_2024)
    expect(periodIdForDate(periods, '2024-12-31')).toBe(PERIOD_2024)
    expect(periodIdForDate(periods, '2025-06-01')).toBe(PERIOD_2025)
    expect(periodIdForDate(periods, '2023-06-01')).toBeNull()
  })
})

describe('resolveDatedRef', () => {
  const index = buildVoucherIndex([
    makeVoucher({ id: 'je-2024' }),
    makeVoucher({ id: 'je-2025', fiscal_period_id: PERIOD_2025, entry_date: '2025-03-14' }),
  ])

  it('resolves via the fiscal period the attachment date falls in', () => {
    expect(resolveDatedRef(index, periods, { series: 'A', number: 31, date: '2024-05-02' })).toBe(
      'je-2024',
    )
    expect(resolveDatedRef(index, periods, { series: 'A', number: 31, date: '2025-05-02' })).toBe(
      'je-2025',
    )
  })

  it('returns undefined when the date falls outside every known period', () => {
    expect(
      resolveDatedRef(index, periods, { series: 'A', number: 31, date: '2023-05-02' }),
    ).toBeUndefined()
  })

  it('resolves a financial-year window when exactly one entry falls inside it', () => {
    expect(
      resolveDatedRef(index, periods, {
        series: 'A',
        number: 31,
        date: '2024-01-01',
        dateTo: '2024-12-31',
      }),
    ).toBe('je-2024')
  })

  it('refuses a financial-year window that spans two candidates', () => {
    expect(
      resolveDatedRef(index, periods, {
        series: 'A',
        number: 31,
        date: '2024-01-01',
        dateTo: '2025-12-31',
      }),
    ).toBeUndefined()
  })

  it('returns undefined for an ambiguous key rather than picking one', () => {
    const ambiguous = buildVoucherIndex([makeVoucher({ id: 'je-1' }), makeVoucher({ id: 'je-2' })])

    expect(
      resolveDatedRef(ambiguous, periods, { series: 'A', number: 31, date: '2024-05-02' }),
    ).toBeUndefined()
  })
})

describe('labels', () => {
  it('separates our voucher label from the source label', () => {
    const entry = makeVoucher({ id: 'je-1' })

    expect(voucherLabel(entry)).toBe('A47')
    expect(sourceVoucherLabel(entry)).toBe('A31')
  })

  it('returns null when a label is not fully populated', () => {
    expect(voucherLabel({ voucher_series: 'A', voucher_number: null })).toBeNull()
    expect(sourceVoucherLabel({ source_voucher_series: null, source_voucher_number: 31 })).toBeNull()
  })
})
