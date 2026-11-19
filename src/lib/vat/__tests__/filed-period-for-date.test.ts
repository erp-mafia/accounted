import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VatFilingRecord } from '../filing-record'

const listVatFilings = vi.fn<() => Promise<VatFilingRecord[]>>()
vi.mock('../filing-record-store', () => ({ listVatFilings: () => listVatFilings() }))

import { distinctFiledVatPeriods, filedVatPeriodOfDate, filedVatPeriodsOfDates } from '../filed-period-for-date'

function record(overrides: Partial<VatFilingRecord>): VatFilingRecord {
  return {
    deadline_id: 'd-1',
    period_type: 'quarterly',
    year: 2026,
    period: 3,
    tax_period: '2026-Q3',
    period_start: '2026-07-01',
    period_end: '2026-09-30',
    filed_on: '2026-11-11',
    source: 'skatteverket',
    reference: null,
    ...overrides,
  }
}

const Q3 = { tax_period: '2026-Q3', period_start: '2026-07-01', period_end: '2026-09-30', filed_on: '2026-11-11' }
const supabase = {} as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('filedVatPeriodOfDate', () => {
  it('holds the first and the last day of the period, and neither neighbour', () => {
    const filings = [record({})]
    expect(filedVatPeriodOfDate(filings, '2026-07-01')).toEqual(Q3)
    expect(filedVatPeriodOfDate(filings, '2026-09-30')).toEqual(Q3)
    expect(filedVatPeriodOfDate(filings, '2026-06-30')).toBeNull()
    expect(filedVatPeriodOfDate(filings, '2026-10-01')).toBeNull()
  })

  it('answers a helårsmoms record by the räkenskapsår it declares, a broken year included', () => {
    const filings = [
      record({
        period_type: 'yearly',
        year: 2026,
        period: 1,
        tax_period: '2025/2026',
        period_start: '2025-07-01',
        period_end: '2026-06-30',
        filed_on: '2026-08-20',
      }),
    ]
    expect(filedVatPeriodOfDate(filings, '2025-12-31')?.tax_period).toBe('2025/2026')
    expect(filedVatPeriodOfDate(filings, '2026-07-01')).toBeNull()
  })

  it('lets the record filed last answer when two hold the same day', () => {
    const filings = [
      record({ deadline_id: 'd-month', period_type: 'monthly', period: 9, tax_period: '2026-09', period_start: '2026-09-01', filed_on: '2026-10-12' }),
      record({}),
    ]
    expect(filedVatPeriodOfDate(filings, '2026-09-15')?.tax_period).toBe('2026-Q3')
    expect(filedVatPeriodOfDate([...filings].reverse(), '2026-09-15')?.tax_period).toBe('2026-Q3')
  })

  it('has no answer when nothing is filed', () => {
    expect(filedVatPeriodOfDate([], '2026-09-15')).toBeNull()
  })
})

describe('filedVatPeriodsOfDates', () => {
  it('reads the filing record once for every date asked', async () => {
    listVatFilings.mockResolvedValue([record({})])
    const found = await filedVatPeriodsOfDates(supabase, 'c-1', ['2026-08-06', '2026-09-27', '2026-10-20', '2026-08-06'])
    expect(listVatFilings).toHaveBeenCalledTimes(1)
    expect([...found.keys()].sort()).toEqual(['2026-08-06', '2026-09-27'])
    expect(found.get('2026-09-27')).toEqual(Q3)
  })

  it('reads nothing when no date is asked', async () => {
    expect((await filedVatPeriodsOfDates(supabase, 'c-1', [])).size).toBe(0)
    expect((await filedVatPeriodsOfDates(supabase, 'c-1', [''])).size).toBe(0)
    expect(listVatFilings).not.toHaveBeenCalled()
  })

  it('throws when the filing record cannot be read, so a door never reads a failure as "not filed"', async () => {
    listVatFilings.mockRejectedValue(new Error('deadlines unreadable'))
    await expect(filedVatPeriodsOfDates(supabase, 'c-1', ['2026-08-06'])).rejects.toThrow('deadlines unreadable')
  })
})

describe('distinctFiledVatPeriods', () => {
  it('names each period once, earliest first', () => {
    const q2 = { tax_period: '2026-Q2', period_start: '2026-04-01', period_end: '2026-06-30', filed_on: '2026-08-17' }
    const found = new Map([
      ['2026-09-27', Q3],
      ['2026-05-28', q2],
      ['2026-08-06', Q3],
    ])
    expect(distinctFiledVatPeriods(found)).toEqual([q2, Q3])
  })
})
