import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VatFilingRecord } from '../filing-record'

const listVatFilings = vi.fn<() => Promise<VatFilingRecord[]>>()
vi.mock('../filing-record-store', () => ({ listVatFilings: () => listVatFilings() }))

import { filedVatPeriodsReopenedBy } from '../filed-periods-reopened'

function record(overrides: Partial<VatFilingRecord>): VatFilingRecord {
  return {
    deadline_id: 'd-1',
    period_type: 'quarterly',
    year: 2026,
    period: 1,
    tax_period: '2026-Q1',
    period_start: '2026-01-01',
    period_end: '2026-03-31',
    filed_on: '2026-05-10',
    source: 'manual',
    reference: null,
    ...overrides,
  }
}

const supabase = {} as SupabaseClient

describe('filedVatPeriodsReopenedBy', () => {
  it('judges every cadence by the range its record declares, a broken räkenskapsår included', async () => {
    listVatFilings.mockResolvedValue([
      record({}),
      // Helårsmoms, räkenskapsår 2025-07-01 - 2026-06-30.
      record({
        deadline_id: 'd-fy',
        period_type: 'yearly',
        year: 2026,
        period: 1,
        tax_period: '2025/2026',
        period_start: '2025-07-01',
        period_end: '2026-06-30',
        filed_on: '2026-08-20',
      }),
    ])
    // Lock moves back from 2026-06-30 to 2026-03-31: Q1 stays locked, the
    // räkenskapsår ending in June reopens for its last quarter.
    const reopened = await filedVatPeriodsReopenedBy(supabase, 'c-1', '2026-06-30', '2026-03-31')
    expect(reopened).toEqual([
      { tax_period: '2025/2026', period_start: '2025-07-01', period_end: '2026-06-30', filed_on: '2026-08-20' },
    ])
  })

  it('reports nothing when the lock moves forward or nothing is locked', async () => {
    listVatFilings.mockResolvedValue([record({})])
    expect(await filedVatPeriodsReopenedBy(supabase, 'c-1', null, '2026-01-01')).toEqual([])
    expect(await filedVatPeriodsReopenedBy(supabase, 'c-1', '2026-03-31', '2026-06-30')).toEqual([])
  })
})
