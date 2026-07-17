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
    preliminary_tax_monthly: 5000,
    vat_registered: true,
    pays_salaries: false,
    fiscal_year_start_month: 1,
    vat_taxable_base_over_40m: false,
    vat_has_eu_trade: false,
    vat_filing_method: 'electronic',
    periodisk_sammanstallning_enabled: false,
    periodisk_sammanstallning_period: 'monthly',
    periodisk_sammanstallning_filing_method: 'electronic',
    ...overrides,
  }
}

describe('VAT filing deadlines', () => {
  it('uses the second following month for monthly filers at or below SEK 40 million', () => {
    const dates = getConfig('moms_monthly').generateDates(2026, makeSettings({ moms_period: 'monthly' }))

    expect(dates[0]).toMatchObject({ day: 12, month: 2, year: 2026, period: '2026-01' })
    expect(dates[10]).toMatchObject({ day: 17, month: 0, year: 2027, period: '2026-11' })
  })

  it('uses the following month for monthly filers above SEK 40 million', () => {
    const dates = getConfig('moms_monthly').generateDates(2026, makeSettings({
      moms_period: 'monthly',
      vat_taxable_base_over_40m: true,
    }))

    expect(dates[0]).toMatchObject({ day: 26, month: 1, year: 2026, period: '2026-01' })
    // Raw date stays the 26th even in December; the banking-day adjustment
    // in the generator moves annandag jul to Skatteverket's published 27th.
    expect(dates[10]).toMatchObject({ day: 26, month: 11, year: 2026, period: '2026-11' })
  })

  it('uses May, August, November and February for quarterly VAT', () => {
    const dates = getConfig('moms_quarterly').generateDates(2026, makeSettings())

    expect(dates.map(({ day, month, year }) => ({ day, month, year }))).toEqual([
      { day: 12, month: 4, year: 2026 },
      { day: 17, month: 7, year: 2026 },
      { day: 12, month: 10, year: 2026 },
      { day: 12, month: 1, year: 2027 },
    ])
  })

  it('uses the entity, EU-trade and filing-method rules for yearly VAT', () => {
    const config = getConfig('moms_yearly')

    expect(config.generateDates(2027, makeSettings({
      entity_type: 'enskild_firma',
      moms_period: 'yearly',
    }))[0]).toMatchObject({ day: 12, month: 4, year: 2027, period: '2026' })
    expect(config.generateDates(2027, makeSettings({
      entity_type: 'enskild_firma',
      moms_period: 'yearly',
      vat_has_eu_trade: true,
    }))[0]).toMatchObject({ day: 26, month: 1, year: 2027, period: '2026' })
    expect(config.generateDates(2027, makeSettings({
      moms_period: 'yearly',
      vat_filing_method: 'paper',
    }))[0]).toMatchObject({ day: 12, month: 6, year: 2027, period: '2026' })
  })
})

describe('monthly tax and employer deadlines', () => {
  it('generates preliminary tax deadlines only when an amount is debited', () => {
    const config = getConfig('f_skatt')
    // F-skatt approval alone carries no payment obligation.
    expect(config.condition(makeSettings({ preliminary_tax_monthly: null }))).toBe(false)
    expect(config.condition(makeSettings({ preliminary_tax_monthly: 0 }))).toBe(false)
    expect(config.condition(makeSettings({ preliminary_tax_monthly: 2500 }))).toBe(true)
    // The debited amount governs even without F-skatt approval (SA-skatt).
    expect(config.condition(makeSettings({ f_skatt: false, preliminary_tax_monthly: 2500 }))).toBe(true)
  })

  it('uses the 12th for preliminary tax except January and August', () => {
    const dates = getConfig('f_skatt').generateDates(2026, makeSettings())
    expect(dates[0].day).toBe(17)
    expect(dates[1].day).toBe(12)
    expect(dates[7].day).toBe(17)
  })

  it('keeps the 12th in August for storföretag preliminary tax (January-only 17th)', () => {
    const dates = getConfig('f_skatt').generateDates(2026, makeSettings({
      moms_period: 'monthly',
      vat_taxable_base_over_40m: true,
    }))
    expect(dates[0].day).toBe(17)
    expect(dates[7].day).toBe(12)
  })

  it('uses the 26th for AGI when the VAT taxable base is above SEK 40 million', () => {
    const dates = getConfig('arbetsgivardeklaration').generateDates(2026, makeSettings({
      pays_salaries: true,
      vat_taxable_base_over_40m: true,
    }))
    expect(dates.every((date) => date.day === 26)).toBe(true)
  })

  it('keeps the 12th for AGI when the employer does not report VAT', () => {
    const dates = getConfig('arbetsgivardeklaration').generateDates(2026, makeSettings({
      pays_salaries: true,
      vat_registered: false,
      vat_taxable_base_over_40m: true,
    }))

    expect(dates[1].day).toBe(12)
    expect(dates[11].day).toBe(17) // December salaries are declared 17 January
  })
})

describe('storföretag tax payment deadline', () => {
  const config = getConfig('skatteinbetalning')

  it('applies only to employers reporting VAT above SEK 40 million', () => {
    expect(config.condition(makeSettings({ pays_salaries: true }))).toBe(false)
    expect(config.condition(makeSettings({ vat_taxable_base_over_40m: true }))).toBe(false)
    expect(config.condition(makeSettings({
      pays_salaries: true,
      vat_taxable_base_over_40m: true,
      vat_registered: false,
    }))).toBe(false)
    expect(config.condition(makeSettings({
      pays_salaries: true,
      vat_taxable_base_over_40m: true,
    }))).toBe(true)
  })

  it('is due the 12th of the following month, the 17th in January', () => {
    const dates = config.generateDates(2026, makeSettings({
      pays_salaries: true,
      vat_taxable_base_over_40m: true,
    }))

    expect(dates).toHaveLength(12)
    expect(dates[0]).toMatchObject({ day: 12, month: 1, year: 2026, period: '2026-01' })
    expect(dates[6]).toMatchObject({ day: 12, month: 7, year: 2026, period: '2026-07' })
    expect(dates[11]).toMatchObject({ day: 17, month: 0, year: 2027, period: '2026-12' })
  })
})

describe('periodic EU sales list deadlines', () => {
  const config = getConfig('periodisk_sammanstallning')

  it('is only applicable when explicitly enabled', () => {
    expect(config.condition(makeSettings())).toBe(false)
    expect(config.condition(makeSettings({ periodisk_sammanstallning_enabled: true }))).toBe(true)
  })

  it('uses the 25th monthly for electronic filing', () => {
    const dates = config.generateDates(2026, makeSettings({
      periodisk_sammanstallning_enabled: true,
    }))
    expect(dates).toHaveLength(12)
    expect(dates[0]).toMatchObject({ day: 25, month: 1, year: 2026, period: '2026-01' })
  })

  it('uses the 20th quarterly for paper filing', () => {
    const dates = config.generateDates(2026, makeSettings({
      periodisk_sammanstallning_enabled: true,
      periodisk_sammanstallning_period: 'quarterly',
      periodisk_sammanstallning_filing_method: 'paper',
    }))
    expect(dates).toHaveLength(4)
    expect(dates[0]).toMatchObject({ day: 20, month: 3, year: 2026, period: '2026-Q1' })
  })
})

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
