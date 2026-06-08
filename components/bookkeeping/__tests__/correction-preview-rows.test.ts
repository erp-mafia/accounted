import { describe, it, expect } from 'vitest'
import { makeJournalEntryLine } from '@/tests/helpers'
import {
  buildCorrectionRows,
  formatSignedAmount,
} from '@/components/bookkeeping/correction-preview-rows'

describe('buildCorrectionRows', () => {
  it('returns no rows when both inputs are empty', () => {
    expect(buildCorrectionRows([], [])).toEqual([])
  })

  it('amount change on same accounts — storno cancels original, correction adds the new value', () => {
    const original = [
      makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
    ]
    const corrected = [
      { account_number: '5410', debit_amount: 1200, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1200 },
    ]
    const rows = buildCorrectionRows(original, corrected)

    expect(rows).toEqual([
      { account_number: '1930', original: -1000, storno: 1000, correction: -1200, delta: -200 },
      { account_number: '5410', original: 1000, storno: -1000, correction: 1200, delta: 200 },
    ])
  })

  it('account swap — old account zeros out, new account picks up the value', () => {
    const original = [
      makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
    ]
    const corrected = [
      { account_number: '5420', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ]
    const rows = buildCorrectionRows(original, corrected)

    // 5410 ends at delta=-1000 (drained back), 5420 ends at delta=+1000 (new),
    // 1930 nets to zero — correction matches storno exactly.
    expect(rows.find((r) => r.account_number === '5410')).toEqual({
      account_number: '5410',
      original: 1000,
      storno: -1000,
      correction: 0,
      delta: -1000,
    })
    expect(rows.find((r) => r.account_number === '5420')).toEqual({
      account_number: '5420',
      original: 0,
      storno: 0,
      correction: 1000,
      delta: 1000,
    })
    expect(rows.find((r) => r.account_number === '1930')).toEqual({
      account_number: '1930',
      original: -1000,
      storno: 1000,
      correction: -1000,
      delta: 0,
    })
  })

  it('identical correction has zero delta on every row', () => {
    const original = [
      makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
    ]
    const corrected = [
      { account_number: '5410', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ]
    const rows = buildCorrectionRows(original, corrected)

    expect(rows.every((r) => r.delta === 0)).toBe(true)
  })

  it('accepts string amounts from form inputs', () => {
    const original = [
      makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
    ]
    const corrected = [
      { account_number: '5410', debit_amount: '1500.50', credit_amount: '' },
    ]
    const rows = buildCorrectionRows(original, corrected)

    expect(rows[0]).toEqual({
      account_number: '5410',
      original: 1000,
      storno: -1000,
      correction: 1500.5,
      delta: 500.5,
    })
  })

  it('skips corrected lines with partial account numbers (mid-edit)', () => {
    const original = [
      makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
    ]
    const corrected = [
      { account_number: '54', debit_amount: 1200, credit_amount: 0 },
      { account_number: '193', debit_amount: 0, credit_amount: 1200 },
    ]
    const rows = buildCorrectionRows(original, corrected)

    // Only original 5410 shows up; the partial entries are ignored.
    expect(rows).toHaveLength(1)
    expect(rows[0].account_number).toBe('5410')
    expect(rows[0].correction).toBe(0)
  })

  it('rounds to öre to avoid 0.1+0.2 drift', () => {
    const original = [
      makeJournalEntryLine({ account_number: '5410', debit_amount: 0.1, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '5410', debit_amount: 0.2, credit_amount: 0 }),
    ]
    const rows = buildCorrectionRows(original, [])

    expect(rows[0].original).toBe(0.3)
    expect(rows[0].storno).toBe(-0.3)
  })
})

describe('formatSignedAmount', () => {
  it('formats positive amounts with leading +', () => {
    expect(formatSignedAmount(1200)).toBe('+1\u00a0200,00')
  })

  it('formats negative amounts with unicode minus', () => {
    expect(formatSignedAmount(-1000)).toBe('−1\u00a0000,00')
  })

  it('renders zero as en-dash', () => {
    expect(formatSignedAmount(0)).toBe('–')
  })

  it('always renders two decimals', () => {
    expect(formatSignedAmount(5.5)).toBe('+5,50')
  })
})
