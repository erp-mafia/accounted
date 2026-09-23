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
    employer_registered: null,
    employer_seasonal: false,
    fiscal_year_start_month: 1,
    vat_taxable_base_over_40m: false,
    vat_has_eu_trade: false,
    vat_filing_method: 'electronic',
    periodisk_sammanstallning_enabled: false,
    periodisk_sammanstallning_period: 'monthly',
    periodisk_sammanstallning_filing_method: 'electronic',
    kontrolluppgifter_enabled: false,
    rot_rut_enabled: false,
    oss_enabled: false,
    ioss_enabled: false,
    intrastat_enabled: false,
    punktskatt_enabled: false,
    fyllnadsinbetalning_enabled: false,
    tax_assessment_notices: [],
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

  it('gives an ideell förening the juridisk person helårsmoms schedule, same as an AB', () => {
    const config = getConfig('moms_yearly')
    const ab = config.generateDates(2027, makeSettings({
      entity_type: 'aktiebolag',
      moms_period: 'yearly',
      vat_filing_method: 'paper',
    }))
    const forening = config.generateDates(2027, makeSettings({
      entity_type: 'ideell_forening',
      moms_period: 'yearly',
      vat_filing_method: 'paper',
    }))
    expect(forening).toHaveLength(ab.length)
    expect(forening[0]).toMatchObject({ day: 12, month: 6, year: 2027, period: '2026' })
    // A broken fiscal year is honoured (a förening is not calendar-locked).
    expect(config.generateDates(2027, makeSettings({
      entity_type: 'ideell_forening',
      moms_period: 'yearly',
      fiscal_year_start_month: 7,
      vat_filing_method: 'electronic',
    }))[0]).toMatchObject(config.generateDates(2027, makeSettings({
      entity_type: 'aktiebolag',
      moms_period: 'yearly',
      fiscal_year_start_month: 7,
      vat_filing_method: 'electronic',
    }))[0])
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

  it('gates AGI on employer registration with pays_salaries as legacy fallback', () => {
    const config = getConfig('arbetsgivardeklaration')
    // Never attested: fall back to pays_salaries.
    expect(config.condition(makeSettings({ pays_salaries: true }))).toBe(true)
    expect(config.condition(makeSettings({ pays_salaries: false }))).toBe(false)
    // Attested registration wins over pays_salaries in both directions: a
    // registered employer must file monthly even with zero salaries.
    expect(config.condition(makeSettings({ employer_registered: true }))).toBe(true)
    expect(config.condition(makeSettings({ employer_registered: false, pays_salaries: true }))).toBe(false)
  })

  it('generates only the December-period AGI row for seasonal employers', () => {
    const dates = getConfig('arbetsgivardeklaration').generateDates(2026, makeSettings({
      employer_registered: true,
      employer_seasonal: true,
    }))
    expect(dates).toHaveLength(1)
    // December period, declared 17 January the following year.
    expect(dates[0]).toMatchObject({ day: 17, month: 0, year: 2027, period: '2026-12' })
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
    // Same registration gate as AGI: attested registration wins.
    expect(config.condition(makeSettings({
      employer_registered: true,
      vat_taxable_base_over_40m: true,
    }))).toBe(true)
    expect(config.condition(makeSettings({
      employer_registered: false,
      pays_salaries: true,
      vat_taxable_base_over_40m: true,
    }))).toBe(false)
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

describe('kontrolluppgifter: 31 January (SFL 24 kap. 1 §)', () => {
  const config = getConfig('kontrolluppgifter')

  it('is only applicable when explicitly enabled', () => {
    expect(config.condition(makeSettings())).toBe(false)
    expect(config.condition(makeSettings({ kontrolluppgifter_enabled: true }))).toBe(true)
  })

  it('is due 31 January for the previous income year', () => {
    const dates = config.generateDates(2027, makeSettings({ kontrolluppgifter_enabled: true }))
    expect(dates).toHaveLength(1)
    expect(dates[0]).toMatchObject({
      day: 31, month: 0, year: 2027, period: '2026', periodLabel: '2026',
    })
  })

  it('follows the calendar income year even for broken fiscal years', () => {
    // KU reporting follows the income year (SFL 24 kap.), never the
    // räkenskapsår: a broken FY must not shift the period.
    const dates = config.generateDates(2027, makeSettings({
      kontrolluppgifter_enabled: true,
      fiscal_year_start_month: 7,
    }))
    expect(dates[0]).toMatchObject({ day: 31, month: 0, year: 2027, period: '2026' })
  })
})

describe('rot_rut_begaran: 31 January after the payment year (Lag 2009:194 8 §)', () => {
  const config = getConfig('rot_rut_begaran')

  it('is only applicable when explicitly enabled', () => {
    expect(config.condition(makeSettings())).toBe(false)
    expect(config.condition(makeSettings({ rot_rut_enabled: true }))).toBe(true)
  })

  it('generates a 31 January row only for years with ROT/RUT payments', () => {
    const settings = makeSettings({
      rot_rut_enabled: true,
      rot_rut_payment_years: [2026],
    })
    expect(config.generateDates(2027, settings)).toEqual([
      { day: 31, month: 0, year: 2027, period: '2026', periodLabel: '2026' },
    ])
    // No payments in 2027 → no row for the 2028 deadline year.
    expect(config.generateDates(2028, settings)).toEqual([])
  })

  it('generates nothing when payment years are unknown (pure-settings contexts)', () => {
    // Backfill detection passes settings without the derived field: the
    // deadline must never be "expected" there, or the nightly cron would
    // regenerate (and status-reset) the company every day.
    const settings = makeSettings({ rot_rut_enabled: true })
    expect(config.generateDates(2027, settings)).toEqual([])
  })
})

describe('long-tail opt-in deadlines', () => {
  it('kvarskatt copies the exact notice date and never applies a banking-day shift', () => {
    const config = getConfig('kvarskatt')
    const settings = makeSettings({
      tax_assessment_notices: [{
        id: 'notice-1',
        fiscalPeriodName: '2029',
        decisionType: 'final',
        paymentDueDate: '2030-03-31',
      }],
    })

    expect(config.condition(settings)).toBe(true)
    expect(config.skipBankingDayAdjustment).toBe(true)
    expect(config.generateDates(2030, settings)).toEqual([{
      day: 31,
      month: 2,
      year: 2030,
      period: 'notice:notice-1',
      periodLabel: 'slutskattebesked, 2029',
      taxAssessmentNoticeId: 'notice-1',
    }])
  })

  it('OSS: quarterly, last day of the month after the quarter, opt-in, no banking-day shift', () => {
    const config = getConfig('oss_quarterly')
    expect(config.condition(makeSettings())).toBe(false)
    expect(config.condition(makeSettings({ oss_enabled: true }))).toBe(true)
    // Requires VAT registration.
    expect(config.condition(makeSettings({ oss_enabled: true, vat_registered: false }))).toBe(false)
    expect(config.skipBankingDayAdjustment).toBe(true)

    const dates = config.generateDates(2030, makeSettings({ oss_enabled: true }))
    expect(dates.map(({ day, month, year }) => ({ day, month, year }))).toEqual([
      { day: 30, month: 3, year: 2030 },
      { day: 31, month: 6, year: 2030 },
      { day: 31, month: 9, year: 2030 },
      { day: 31, month: 0, year: 2031 },
    ])
  })

  it('IOSS: opt-in alone controls the deadline (Art. 369s does not require Swedish VAT registration)', () => {
    const config = getConfig('ioss_monthly')
    expect(config.condition(makeSettings({ ioss_enabled: true, vat_registered: false }))).toBe(true)
    expect(config.condition(makeSettings({ ioss_enabled: false }))).toBe(false)
  })

  it('IOSS: monthly, last day of the following month, no banking-day shift', () => {
    const config = getConfig('ioss_monthly')
    expect(config.skipBankingDayAdjustment).toBe(true)
    const dates = config.generateDates(2030, makeSettings({ ioss_enabled: true }))
    expect(dates).toHaveLength(12)
    // February 2030 → due 31 March 2030 (a Sunday: the EU deadline stands).
    expect(dates[1]).toMatchObject({ day: 31, month: 2, year: 2030, period: '2030-02' })
    // December 2030 → due 31 January 2031.
    expect(dates[11]).toMatchObject({ day: 31, month: 0, year: 2031, period: '2030-12' })
  })

  it('Intrastat: 10th banking day of the month after the reference month', () => {
    const config = getConfig('intrastat_monthly')
    const dates = config.generateDates(2030, makeSettings({ intrastat_enabled: true }))
    // January 2030 → February 2030: banking days 1,4,5,6,7,8,11,12,13,14.
    expect(dates[0]).toMatchObject({ day: 14, month: 1, year: 2030, period: '2030-01' })
  })

  it('punktskatt: ordinary skattedeklaration schedule (12th, 17th in Jan/Aug)', () => {
    const config = getConfig('punktskatt_monthly')
    expect(config.condition(makeSettings({ punktskatt_enabled: true, vat_registered: false }))).toBe(true)
    const dates = config.generateDates(2030, makeSettings({ punktskatt_enabled: true }))
    expect(dates[0]).toMatchObject({ day: 12, month: 1, year: 2030, period: '2030-01' })
    expect(dates[6]).toMatchObject({ day: 17, month: 7, year: 2030, period: '2030-07' })
    expect(dates[11]).toMatchObject({ day: 17, month: 0, year: 2031, period: '2030-12' })
  })

  it('fyllnadsinbetalning: 12th of 2nd month over 30k, 3rd of 5th month for the rest (SFL 62:8, 65 kap.)', () => {
    const config = getConfig('fyllnadsinbetalning')
    // Calendar FY 2030: 12 Feb 2031 and 3 May 2031.
    const dates = config.generateDates(2031, makeSettings({ fyllnadsinbetalning_enabled: true }))
    expect(dates.map(({ day, month, year }) => ({ day, month, year }))).toEqual([
      { day: 12, month: 1, year: 2031 },
      { day: 3, month: 4, year: 2031 },
    ])
    expect(dates[0].period).toBe('2030-over30k')
    expect(dates[1].period).toBe('2030-rest')

    // Broken FY ending June 2030 (start July): 12 Aug 2030 and 3 Nov 2030.
    const broken = config.generateDates(2030, makeSettings({
      fyllnadsinbetalning_enabled: true,
      fiscal_year_start_month: 7,
    }))
    expect(broken.map(({ day, month, year }) => ({ day, month, year }))).toEqual([
      { day: 12, month: 7, year: 2030 },
      { day: 3, month: 10, year: 2030 },
    ])
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

describe('arsstamma: 6 months after FY end (ABL 7:10)', () => {
  const config = getConfig('arsstamma')

  it('applies only to aktiebolag', () => {
    expect(config.condition(makeSettings())).toBe(true)
    expect(config.condition(makeSettings({ entity_type: 'enskild_firma' }))).toBe(false)
  })

  it('FY end Dec (calendar year) → Jun 30 next year', () => {
    const dates = config.generateDates(2026, makeSettings({ fiscal_year_start_month: 1 }))
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 30, month: 5, year: 2026, period: '2025' })
  })

  it('FY end Apr → Oct 31 same year, broken-FY period label', () => {
    const dates = config.generateDates(2026, makeSettings({ fiscal_year_start_month: 5 }))
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 31, month: 9, year: 2026, period: '2025/2026' })
  })

  it('uses the last day of the deadline month (handles Feb)', () => {
    // FY end Aug 2026 → +6 months = Feb 2027
    const dates = config.generateDates(2027, makeSettings({ fiscal_year_start_month: 9 }))
    expect(dates.length).toBe(1)
    expect(dates[0]).toMatchObject({ day: 28, month: 1, year: 2027 })
  })

  it('no bokslut deadline type exists anymore', () => {
    expect(TAX_DEADLINE_CONFIGS.find((c) => (c.type as string) === 'bokslut')).toBeUndefined()
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
