import { describe, expect, it } from 'vitest'
import { getApplicableDeadlineConfigs, TAX_DEADLINE_CONFIGS } from '../deadline-config'
import type { CompanySettingsForDeadlines } from '../deadline-config'
import { adjustDeadlineToNextBankingDay } from '../swedish-holidays'
import { formatDateISO } from '@/lib/calendar/utils'
import { deadlineMatchesKind } from '@/lib/portfolio/overview'

/**
 * Inkomstdeklaration 3 for an ideell förening (#47). Skatteverket's table
 * ("Du ska ha skickat in inkomstdeklaration 3"), valid for digital and paper
 * filing alike, with no byråanstånd:
 *
 *   räkenskapsår ends January-April   -> 1 December the same year
 *   räkenskapsår ends May-June        -> 15 January the year after
 *   räkenskapsår ends July-August     -> 1 April the year after
 *   räkenskapsår ends September-December -> 1 August the year after
 *
 * The generator moves a date on a weekend or holiday to the next banking day,
 * like INK2: Skatteverket lists 2 August 2027 for a 2026 calendar year.
 */

const config = TAX_DEADLINE_CONFIGS.find((c) => c.type === 'inkomstdeklaration_ideell_forening')!

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

/** The due date the generator writes: the raw date moved to a banking day. */
function dueDates(year: number, fiscalYearStartMonth: number) {
  return config.generateDates(year, settings({ fiscal_year_start_month: fiscalYearStartMonth })).map((d) => ({
    due: formatDateISO(adjustDeadlineToNextBankingDay(new Date(d.year, d.month, d.day))),
    period: d.period,
  }))
}

describe('inkomstdeklaration_ideell_forening', () => {
  it('applies to the form whose return is INK3, and to no other', () => {
    expect(config).toBeDefined()
    expect(config.priority).toBe('critical')
    expect(config.linkedReportType).toBe('ink3-declaration')
    expect(config.skipBankingDayAdjustment).toBeUndefined()
    expect(getApplicableDeadlineConfigs(settings()).map((c) => c.type)).toContain('inkomstdeklaration_ideell_forening')
    for (const form of ['aktiebolag', 'enskild_firma', 'ekonomisk_forening'] as const) {
      expect(config.condition(settings({ entity_type: form })), form).toBe(false)
    }
  })

  it('a calendar year 2026 is due 2 August 2027 (1 August is a Sunday)', () => {
    expect(dueDates(2027, 1)).toEqual([{ due: '2027-08-02', period: '2026' }])
  })

  it.each([
    // [räkenskapsår starts, deadline year, due date, period label]
    [2, 2026, '2026-12-01', '2025/2026'], // ends January 2026
    [5, 2026, '2026-12-01', '2025/2026'], // ends April 2026
    [6, 2027, '2027-01-15', '2025/2026'], // ends May 2026
    [7, 2027, '2027-01-15', '2025/2026'], // ends June 2026
    [8, 2027, '2027-04-01', '2025/2026'], // ends July 2026
    [9, 2027, '2027-04-01', '2025/2026'], // ends August 2026
    [10, 2027, '2027-08-02', '2025/2026'], // ends September 2026
    [1, 2027, '2027-08-02', '2026'], // ends December 2026
  ])('a räkenskapsår starting in month %i is due %s', (startMonth, deadlineYear, due, period) => {
    expect(dueDates(deadlineYear, startMonth)).toEqual([{ due, period }])
  })

  it("counts as an inkomstdeklaration in the byrå's client overview filter", () => {
    expect(deadlineMatchesKind('inkomstdeklaration_ideell_forening', 'inkomstdeklaration')).toBe(true)
  })

  it('moves a weekend date to the next banking day (15 January 2028 is a Saturday)', () => {
    expect(dueDates(2028, 7)).toEqual([{ due: '2028-01-17', period: '2026/2027' }])
  })
})
