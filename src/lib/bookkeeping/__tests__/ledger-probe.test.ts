import { describe, expect, it } from 'vitest'
import { planLedgerProbe, type EmptyListScope } from '@/lib/bookkeeping/ledger-probe'

const unfiltered: EmptyListScope = {
  periodId: null,
  search: '',
  seriesFilter: 'all',
  dateFrom: '',
  dateTo: '',
  showMissingOnly: false,
}

describe('planLedgerProbe', () => {
  it('answers from the list total when nothing narrows the list', () => {
    expect(planLedgerProbe(unfiltered)).toBe('from_total')
  })

  it('probes all years when only the fiscal-year scope narrows an empty list', () => {
    expect(planLedgerProbe({ ...unfiltered, periodId: 'fy-2026' })).toBe('probe')
  })

  // crm#1390: the "Verifikat utan underlag" deep link with nothing missing
  // waited seconds for an all-years read whose answer it could not use.
  it('skips the probe for an empty missing-underlag view, with or without a year', () => {
    expect(planLedgerProbe({ ...unfiltered, showMissingOnly: true })).toBe('skip')
    expect(planLedgerProbe({ ...unfiltered, showMissingOnly: true, periodId: 'fy-2026' })).toBe('skip')
  })

  it('skips the probe under a search or any other dialog filter', () => {
    const scoped = { ...unfiltered, periodId: 'fy-2026' }
    expect(planLedgerProbe({ ...scoped, search: 'hyra' })).toBe('skip')
    expect(planLedgerProbe({ ...scoped, seriesFilter: 'B' })).toBe('skip')
    expect(planLedgerProbe({ ...scoped, dateFrom: '2026-01-01' })).toBe('skip')
    expect(planLedgerProbe({ ...scoped, dateTo: '2026-12-31' })).toBe('skip')
    expect(planLedgerProbe({ ...unfiltered, search: 'hyra' })).toBe('skip')
  })
})
