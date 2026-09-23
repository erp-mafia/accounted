/**
 * The size metrics behind the ÅRL 1:3 § (större företag) and K2-relief
 * checks must disclose the same employee figure as Not 2 and the iXBRL
 * fact. The skeptic on the medelantal override found the metrics still
 * reading the FTE average while the note used the manual figure: a
 * SIE-migrated company with no employees rows and an override of 60 would
 * have validated as a mindre företag while its own document said 60.
 */
import { describe, it, expect } from 'vitest'
import { reportMetrics } from '../model'
import type { buildArsredovisningData } from '../build-data'

type Report = Awaited<ReturnType<typeof buildArsredovisningData>>

function makeReport(overrides: {
  currentOverride: number | null
  withPrevious?: boolean
}): Report {
  return {
    fiscal_period: {
      id: 'fp-2025',
      name: '2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    },
    previous_period: overrides.withPrevious
      ? { id: 'fp-2024', name: '2024', period_start: '2024-01-01', period_end: '2024-12-31' }
      : null,
    forvaltningsberattelse: {
      flerarsoversikt: [
        { year: '2025', net_revenue: 50_000_000 },
        { year: '2024', net_revenue: 50_000_000 },
      ],
    },
    balansrakning: {
      total_assets: 45_000_000,
      total_assets_previous: overrides.withPrevious ? 45_000_000 : null,
    },
    disclosures: {
      medelantal_anstallda_override: overrides.currentOverride,
    },
  } as unknown as Report
}

const fullYearEmployee = {
  employment_start: '2020-01-01',
  employment_end: null,
  employment_degree: 100,
}

describe('reportMetrics: employee figure follows the medelantal override', () => {
  it('uses the FTE average from employees when no override is set', () => {
    const metrics = reportMetrics(makeReport({ currentOverride: null }), [fullYearEmployee])
    expect(metrics.current.employees).toBe(1)
  })

  it('uses the current period override for the current year', () => {
    const metrics = reportMetrics(makeReport({ currentOverride: 60 }), [])
    expect(metrics.current.employees).toBe(60)
  })

  it('uses the previous period override for the jämförelseår', () => {
    const metrics = reportMetrics(
      makeReport({ currentOverride: 60, withPrevious: true }),
      [],
      60,
    )
    expect(metrics.previous?.employees).toBe(60)
  })

  it('falls back to the FTE average for the previous year when it has no override', () => {
    const metrics = reportMetrics(
      makeReport({ currentOverride: 2, withPrevious: true }),
      [fullYearEmployee],
      null,
    )
    expect(metrics.current.employees).toBe(2)
    expect(metrics.previous?.employees).toBe(1)
  })
})
