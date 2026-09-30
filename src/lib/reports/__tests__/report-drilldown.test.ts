import { describe, it, expect } from 'vitest'
import {
  huvudbokDrilldownHref,
  parseDrilldownParams,
  sameWindow,
  windowFitsPeriod,
} from '../report-drilldown'

const paramsOf = (href: string) => new URLSearchParams(href.slice(href.indexOf('?') + 1))

describe('huvudbokDrilldownHref / parseDrilldownParams', () => {
  it('carries the clicked report window and dimension filter to the huvudbok, and reads them back', () => {
    const href = huvudbokDrilldownHref('3001', {
      fromDate: '2026-07-01',
      toDate: '2026-09-30',
      dimension: { dimNo: '6', code: 'P100' },
    })

    expect(href.startsWith('/reports/huvudbok?')).toBe(true)
    const params = paramsOf(href)
    expect(params.get('account')).toBe('3001')
    expect(parseDrilldownParams(params)).toEqual({
      range: { fromDate: '2026-07-01', toDate: '2026-09-30' },
      dimension: { dimNo: '6', code: 'P100' },
    })
  })

  it('encodes codes and accounts that need escaping', () => {
    const href = huvudbokDrilldownHref('3001', { dimension: { dimNo: '20', code: 'Ö&Å +1' } })
    expect(parseDrilldownParams(paramsOf(href)).dimension).toEqual({ dimNo: '20', code: 'Ö&Å +1' })
  })

  it('leaves out what the report did not have', () => {
    const href = huvudbokDrilldownHref('1930', { dimension: null })
    expect(href).toBe('/reports/huvudbok?account=1930')
    expect(parseDrilldownParams(paramsOf(href))).toEqual({ range: {}, dimension: null })
  })

  it('drops a malformed part instead of guessing it', () => {
    const parsed = parseDrilldownParams(
      new URLSearchParams({ account: '3001', from_date: '2026-7-1', to_date: '2026-09-30', dim_no: '6' }),
    )
    // The bad date goes; the good one stays. A half filter pair is no filter.
    expect(parsed).toEqual({ range: { toDate: '2026-09-30' }, dimension: null })

    for (const [dimNo, code] of [['06', 'P1'], ['x', 'P1'], ['6', 'P{1}'], ['6', 'a'.repeat(41)]]) {
      expect(parseDrilldownParams(new URLSearchParams({ dim_no: dimNo, dim_code: code })).dimension).toBeNull()
    }
  })
})

describe('windowFitsPeriod', () => {
  const start = '2026-01-01'
  const end = '2026-12-31'

  it('accepts a window inside the period, one-sided or both', () => {
    expect(windowFitsPeriod({ fromDate: '2026-07-01', toDate: '2026-09-30' }, start, end)).toBe(true)
    expect(windowFitsPeriod({ toDate: '2026-06-30' }, start, end)).toBe(true)
    expect(windowFitsPeriod({ fromDate: start, toDate: end }, start, end)).toBe(true)
  })

  it('refuses an empty window, one outside the period, and one running backwards', () => {
    expect(windowFitsPeriod({}, start, end)).toBe(false)
    expect(windowFitsPeriod({ fromDate: '2025-12-31' }, start, end)).toBe(false)
    expect(windowFitsPeriod({ toDate: '2027-01-01' }, start, end)).toBe(false)
    expect(windowFitsPeriod({ fromDate: '2026-09-30', toDate: '2026-07-01' }, start, end)).toBe(false)
  })
})

describe('sameWindow', () => {
  it('reads an open end as the period bound, so the whole year equals no window at all', () => {
    expect(sameWindow({}, { fromDate: '2026-01-01', toDate: '2026-12-31' }, '2026-01-01', '2026-12-31')).toBe(true)
    expect(sameWindow({ toDate: '2026-06-30' }, { fromDate: '2026-01-01', toDate: '2026-06-30' }, '2026-01-01', '2026-12-31')).toBe(true)
    expect(sameWindow({ fromDate: '2026-07-01' }, { fromDate: '2026-07-02' }, '2026-01-01', '2026-12-31')).toBe(false)
  })
})
