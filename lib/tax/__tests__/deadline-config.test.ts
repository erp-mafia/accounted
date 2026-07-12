import { describe, it, expect } from 'vitest'
import { TAX_DEADLINE_CONFIGS } from '../deadline-config'
import type { CompanySettingsForDeadlines } from '../deadline-config'

function getConfig(type: string) {
  return TAX_DEADLINE_CONFIGS.find((c) => c.type === type)!
}

function makeSettings(overrides: Partial<CompanySettingsForDeadlines> = {}): CompanySettingsForDeadlines {
  return {
    entity_type: 'aktiebolag',
    moms_period: 'quarterly',
    f_skatt: true,
    vat_registered: true,
    pays_salaries: false,
    fiscal_year_start_month: 1,
    ...overrides,
  }
}

describe('inkomstdeklaration_ab: digital filing deadlines', () => {
  const config = getConfig('inkomstdeklaration_ab')

  it('FY end Dec (calendar year) → Aug 1 next year', () => {
    // FY ends Dec 2024, deadline Aug 1, 2025
    const settings = makeSettings({ fiscal_year_start_month: 1 }) // end month = 12
    const dates = config.generateDates(2025, settings)
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 1, month: 7, year: 2025 }) // Aug (0-indexed)
  })

  it('FY end Sep → Aug 1 next year', () => {
    // FY start Oct, end Sep. FY ending Sep 2024 → deadline Aug 1, 2025
    const settings = makeSettings({ fiscal_year_start_month: 10 }) // end month = 9
    const dates = config.generateDates(2025, settings)
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 1, month: 7, year: 2025 }) // Aug
  })

  it('FY end Oct → Aug 1 next year', () => {
    const settings = makeSettings({ fiscal_year_start_month: 11 }) // end month = 10
    const dates = config.generateDates(2025, settings)
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 1, month: 7, year: 2025 }) // Aug
  })

  it('FY end Jan → Dec 1 same year', () => {
    // FY start Feb, end Jan. FY ending Jan 2025 → deadline Dec 1, 2025
    const settings = makeSettings({ fiscal_year_start_month: 2 }) // end month = 1
    const dates = config.generateDates(2025, settings)
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 1, month: 11, year: 2025 }) // Dec
  })

  it('FY end Apr → Dec 1 same year', () => {
    const settings = makeSettings({ fiscal_year_start_month: 5 }) // end month = 4
    const dates = config.generateDates(2025, settings)
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 1, month: 11, year: 2025 }) // Dec
  })

  it('FY end May → Jan 15 next year', () => {
    // FY ending May 2025 → deadline Jan 15, 2026. So for year=2026:
    const settings = makeSettings({ fiscal_year_start_month: 6 }) // end month = 5
    const dates = config.generateDates(2026, settings)
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 15, month: 0, year: 2026 }) // Jan
  })

  it('FY end Jun → Jan 15 next year', () => {
    const settings = makeSettings({ fiscal_year_start_month: 7 }) // end month = 6
    const dates = config.generateDates(2026, settings)
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 15, month: 0, year: 2026 }) // Jan
  })

  it('FY end Jul → Apr 1 next year', () => {
    // FY ending Jul 2025 → deadline Apr 1, 2026. So for year=2026:
    const settings = makeSettings({ fiscal_year_start_month: 8 }) // end month = 7
    const dates = config.generateDates(2026, settings)
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 1, month: 3, year: 2026 }) // Apr
  })

  it('FY end Aug → Apr 1 next year', () => {
    const settings = makeSettings({ fiscal_year_start_month: 9 }) // end month = 8
    const dates = config.generateDates(2026, settings)
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 1, month: 3, year: 2026 }) // Apr
  })

  it('period labels are correct for calendar year', () => {
    const settings = makeSettings({ fiscal_year_start_month: 1 })
    const dates = config.generateDates(2025, settings)
    expect(dates[0].periodLabel).toBe('2024')
  })

  it('period labels are correct for broken fiscal year', () => {
    const settings = makeSettings({ fiscal_year_start_month: 5 }) // end month = 4
    const dates = config.generateDates(2025, settings)
    expect(dates[0].periodLabel).toMatch(/2024\/2025|2025/)
  })
})

describe('arsredovisning: 7 months after FY end (ÅRL 8:3)', () => {
  const config = getConfig('arsredovisning')

  it('FY end Dec (calendar year) → Jul 31 next year', () => {
    const settings = makeSettings({ fiscal_year_start_month: 1 })
    const dates = config.generateDates(2025, settings)
    expect(dates.length).toBe(1)
    // Dec + 7 months = July (month index 6)
    expect(dates[0]).toMatchObject({ day: 31, month: 6, year: 2025 })
  })

  it('FY end Jun → Jan 31 next year', () => {
    // FY end Jun 2024 → +7 months = Jan 2025
    const settings = makeSettings({ fiscal_year_start_month: 7 }) // end month = 6
    const dates = config.generateDates(2025, settings)
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 31, month: 0, year: 2025 }) // Jan 31
  })

  it('FY end Apr → Nov 30 same year', () => {
    // FY end Apr 2025 → +7 months = Nov 2025
    const settings = makeSettings({ fiscal_year_start_month: 5 }) // end month = 4
    const dates = config.generateDates(2025, settings)
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 30, month: 10, year: 2025 }) // Nov 30
  })

  it('FY end Mar → Oct 31 same year', () => {
    // FY end Mar 2025 → +7 months = Oct 2025
    const settings = makeSettings({ fiscal_year_start_month: 4 }) // end month = 3
    const dates = config.generateDates(2025, settings)
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 31, month: 9, year: 2025 }) // Oct 31
  })

  it('FY end Aug → Mar 31 next year', () => {
    // FY end Aug 2024 → +7 months = Mar 2025
    const settings = makeSettings({ fiscal_year_start_month: 9 }) // end month = 8
    const dates = config.generateDates(2025, settings)
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 31, month: 2, year: 2025 }) // Mar 31
  })

  it('uses last day of deadline month (handles Feb)', () => {
    // FY end Jul 2024 → +7 months = Feb 2025
    const settings = makeSettings({ fiscal_year_start_month: 8 }) // end month = 7
    const dates = config.generateDates(2025, settings)
    expect(dates.length).toBe(1)
    expect(dates[0].month).toBe(1) // Feb
    expect(dates[0].day).toBe(28) // 2025 is not a leap year
  })
})
