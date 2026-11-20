import { describe, it, expect } from 'vitest'
import { TAX_DEADLINE_CONFIGS, getApplicableDeadlineConfigs } from '../deadline-config'
import type { CompanySettingsForDeadlines } from '../deadline-config'
import { ENTITY_TYPES } from '@/lib/company/entity-type'

const config = TAX_DEADLINE_CONFIGS.find((c) => c.type === 'forenklat_arsbokslut')!

function settings(overrides: Partial<CompanySettingsForDeadlines> = {}): CompanySettingsForDeadlines {
  return {
    entity_type: 'ideell_forening',
    moms_period: null,
    f_skatt: false,
    preliminary_tax_monthly: null,
    vat_registered: false,
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

describe('förenklat årsbokslut deadline (BFL 6 kap. 7 §)', () => {
  it('applies to the forms that prepare one: an ideell förening, no other form', () => {
    const applies = ENTITY_TYPES.filter((form) => config.condition(settings({ entity_type: form })))
    expect(applies).toEqual(['ideell_forening'])
  })

  it('gives an ideell förening a statutory year-end deadline, so its list is not empty of one', () => {
    const types = getApplicableDeadlineConfigs(settings()).map((c) => c.type)
    expect(types).toContain('forenklat_arsbokslut')
  })

  it('falls on the last day of the sixth month after the year end', () => {
    expect(config.generateDates(2027, settings())).toEqual([
      expect.objectContaining({ day: 30, month: 5, year: 2027, period: '2026' }),
    ])
    // Brutet räkenskapsår 2026-07-01..2027-06-30: due 2027-12-31.
    expect(config.generateDates(2027, settings({ fiscal_year_start_month: 7 }))).toEqual([
      expect.objectContaining({ day: 31, month: 11, year: 2027, period: '2026/2027' }),
    ])
  })

  it('cites the paragraph and says nothing is filed', () => {
    expect(config.description).toContain('BFL 6 kap. 7 §')
    expect(config.titleTemplate).toContain('Förenklat årsbokslut')
    expect(config.linkedReportType).toBeNull()
  })
})
