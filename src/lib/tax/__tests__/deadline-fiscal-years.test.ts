import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fiscalYearEndMonthIn,
  fiscalYearEndMonthOn,
  fiscalYearForDeadlines,
  fiscalYearsEndingIn,
  type CompanySettingsForDeadlines,
  type FiscalYearForDeadlines,
} from '../deadline-config'
import {
  backfillMissingTaxDeadlines,
  findSettingsMissingUpcomingDeadlines,
  findSettingsWithStaleUpcomingDeadlines,
  getExpectedUpcomingDeadlineKeys,
  toDeadlineSettings,
} from '../deadline-generator'

/**
 * crm#1278: yearly deadlines come from the company's real räkenskapsår
 * (fiscal_periods), and no monthly or quarterly declaration is due for a
 * period before a mid-month first year begins.
 */

function makeSettings(overrides: Partial<CompanySettingsForDeadlines> = {}): CompanySettingsForDeadlines {
  return {
    entity_type: 'aktiebolag',
    moms_period: 'quarterly',
    f_skatt: true,
    preliminary_tax_monthly: null,
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

// The ticket's shape: an AB registered mid-October with its first
// räkenskapsår extended to the end of the following year, quarterly moms.
const EXTENDED_FIRST_YEAR: FiscalYearForDeadlines[] = [{ start: '2026-10-12', end: '2027-12-31' }]

function keys(settings: CompanySettingsForDeadlines, years: number[], from: Date): string[] {
  return Array.from(getExpectedUpcomingDeadlineKeys(settings, years, from)).sort()
}

function rowsFor(companyId: string, keyList: Iterable<string>, overrides: Record<string, unknown> = {}) {
  return Array.from(keyList, (key, index) => {
    const [taxDeadlineType, taxPeriod, dueDate] = key.split(':')
    return {
      id: `${companyId}-${index}`,
      company_id: companyId,
      tax_deadline_type: taxDeadlineType,
      tax_period: taxPeriod,
      due_date: dueDate,
      is_completed: false,
      dismissed_at: null,
      ...overrides,
    }
  })
}

describe('fiscalYearsEndingIn', () => {
  it('is the twelve-month schedule when no fiscal period is recorded', () => {
    expect(fiscalYearsEndingIn([2026], makeSettings({ fiscal_years: [] }))).toEqual([
      { endYear: 2026, endMonth: 12, start: '2026-01-01' },
    ])
    expect(fiscalYearsEndingIn([2026], makeSettings({ fiscal_years: [], fiscal_year_start_month: 5 }))).toEqual([
      { endYear: 2026, endMonth: 4, start: '2025-05-01' },
    ])
  })

  it('has no year ending inside an extended first räkenskapsår, nor before it', () => {
    const settings = makeSettings({ fiscal_years: EXTENDED_FIRST_YEAR })
    expect(fiscalYearsEndingIn([2025, 2026, 2027], settings)).toEqual([
      { endYear: 2027, endMonth: 12, start: '2026-10-12' },
    ])
  })

  it('continues on the twelve-month schedule after the last recorded year', () => {
    const settings = makeSettings({ fiscal_years: EXTENDED_FIRST_YEAR })
    expect(fiscalYearsEndingIn([2028], settings)).toEqual([
      { endYear: 2028, endMonth: 12, start: '2028-01-01' },
    ])
  })

  it('keeps a short first räkenskapsår and drops the year before it', () => {
    const settings = makeSettings({ fiscal_years: [{ start: '2026-03-10', end: '2026-12-31' }] })
    expect(fiscalYearsEndingIn([2025, 2026], settings)).toEqual([
      { endYear: 2026, endMonth: 12, start: '2026-03-10' },
    ])
  })

  it('keeps the year before a first recorded one that starts on the 1st (books kept elsewhere)', () => {
    const calendar = makeSettings({ fiscal_years: [{ start: '2026-01-01', end: '2026-12-31' }] })
    expect(fiscalYearsEndingIn([2025, 2026], calendar)).toEqual([
      { endYear: 2025, endMonth: 12, start: '2025-01-01' },
      { endYear: 2026, endMonth: 12, start: '2026-01-01' },
    ])

    const broken = makeSettings({
      fiscal_year_start_month: 5,
      fiscal_years: [{ start: '2026-05-01', end: '2027-04-30' }],
    })
    expect(fiscalYearsEndingIn([2026, 2027], broken)).toEqual([
      { endYear: 2026, endMonth: 4, start: '2025-05-01' },
      { endYear: 2027, endMonth: 4, start: '2026-05-01' },
    ])
  })

  it('has no year before a first räkenskapsår the company declared, even one starting on the 1st', () => {
    const settings = makeSettings({
      fiscal_year_start_month: 1,
      fiscal_years: [{ start: '2026-04-01', end: '2026-12-31', declaredFirst: true }],
    })
    expect(fiscalYearsEndingIn([2025, 2026], settings)).toEqual([
      { endYear: 2026, endMonth: 12, start: '2026-04-01' },
    ])
  })

  it('chains the years after the last recorded one, whatever the settings month says', () => {
    // A June year on record, a stale January in settings: no short year
    // July-December appears, the next year runs July-June.
    const settings = makeSettings({
      fiscal_year_start_month: 1,
      fiscal_years: [{ start: '2025-07-01', end: '2026-06-30' }],
    })
    expect(fiscalYearsEndingIn([2026, 2027, 2028], settings)).toEqual([
      { endYear: 2026, endMonth: 6, start: '2025-07-01' },
      { endYear: 2027, endMonth: 6, start: '2026-07-01' },
      { endYear: 2028, endMonth: 6, start: '2027-07-01' },
    ])
  })

  it('needs a recorded year to re-lay the räkenskapsår, a settings month alone moves nothing', () => {
    const settings = makeSettings({
      fiscal_year_start_month: 7,
      fiscal_years: [{ start: '2025-01-01', end: '2025-12-31' }],
    })
    expect(fiscalYearsEndingIn([2026], settings)).toEqual([
      { endYear: 2026, endMonth: 12, start: '2026-01-01' },
    ])
    expect(
      fiscalYearsEndingIn([2026], {
        ...settings,
        fiscal_years: [...settings.fiscal_years!, { start: '2026-01-01', end: '2026-06-30' }],
      }),
    ).toEqual([{ endYear: 2026, endMonth: 6, start: '2026-01-01' }])
  })

  it('chains across a gap, and a year that would run into the next one never existed', () => {
    const settings = makeSettings({
      fiscal_year_start_month: 1,
      fiscal_years: [
        { start: '2023-07-01', end: '2024-06-30' },
        { start: '2025-07-01', end: '2026-06-30' },
        { start: '2027-01-01', end: '2027-12-31' },
      ],
    })
    expect(fiscalYearsEndingIn([2024, 2025, 2026], settings)).toEqual([
      { endYear: 2024, endMonth: 6, start: '2023-07-01' },
      { endYear: 2025, endMonth: 6, start: '2024-07-01' },
      { endYear: 2026, endMonth: 6, start: '2025-07-01' },
    ])
  })

  it('fills a gap between recorded years', () => {
    const settings = makeSettings({
      fiscal_years: [
        { start: '2024-01-01', end: '2024-12-31' },
        { start: '2026-01-01', end: '2026-12-31' },
      ],
    })
    expect(fiscalYearsEndingIn([2025], settings)).toEqual([
      { endYear: 2025, endMonth: 12, start: '2025-01-01' },
    ])
  })
})

// An enskild firma imported on years 1 September to 31 August. The generator
// labels its helårsmoms by the calendar year, so the key has to as well.
const BROKEN_ENSKILD_FIRMA = makeSettings({
  entity_type: 'enskild_firma',
  fiscal_years: [
    { start: '2024-09-01', end: '2025-08-31' },
    { start: '2025-09-01', end: '2026-08-31' },
  ],
})

describe('fiscalYearEndMonthIn', () => {
  const recorded = makeSettings({
    fiscal_year_start_month: 1,
    fiscal_years: [{ start: '2025-07-01', end: '2026-06-30' }],
  })

  it('reads the recorded year over the settings month, and the chain after it', () => {
    expect(fiscalYearEndMonthIn(2026, recorded)).toBe(6)
    expect(fiscalYearEndMonthIn(2028, recorded)).toBe(6)
  })

  it('takes the later year when an omläggning ends two in one calendar year', () => {
    const relaid = makeSettings({
      fiscal_years: [
        { start: '2026-01-01', end: '2026-06-30' },
        { start: '2026-07-01', end: '2026-12-31' },
      ],
    })
    expect(fiscalYearEndMonthIn(2026, relaid)).toBe(12)
  })

  it('falls back on the settings month when no year ends in the calendar year', () => {
    const extended = makeSettings({ fiscal_year_start_month: 7, fiscal_years: [{ start: '2026-10-12', end: '2027-12-31' }] })
    expect(fiscalYearEndMonthIn(2026, extended)).toBe(6)
  })

  it('is the settings month alone with nothing recorded, December without one', () => {
    expect(fiscalYearEndMonthIn(2026, makeSettings({ fiscal_year_start_month: 5, fiscal_years: [] }))).toBe(4)
    expect(fiscalYearEndMonthIn(2026, {})).toBe(12)
  })

  it('is December for a form bound to the calendar year, whatever a stored year says', () => {
    expect(fiscalYearEndMonthIn(2026, BROKEN_ENSKILD_FIRMA)).toBe(12)
  })
})

describe('fiscalYearEndMonthOn', () => {
  const recorded = makeSettings({
    fiscal_year_start_month: 1,
    fiscal_years: [
      { start: '2025-07-01', end: '2026-06-30' },
      { start: '2026-07-01', end: '2026-12-31' },
    ],
  })

  it('reads the year running on the day', () => {
    expect(fiscalYearEndMonthOn('2026-03-01', recorded)).toBe(6)
    expect(fiscalYearEndMonthOn('2026-06-30', recorded)).toBe(6)
    expect(fiscalYearEndMonthOn('2026-07-01', recorded)).toBe(12)
  })

  it('reads the chain after the last recorded year', () => {
    const june = makeSettings({ fiscal_year_start_month: 1, fiscal_years: [{ start: '2025-07-01', end: '2026-06-30' }] })
    expect(fiscalYearEndMonthOn('2026-08-05', june)).toBe(6)
  })

  it('finds a year of up to 36 months', () => {
    const long = makeSettings({ fiscal_years: [{ start: '2024-01-01', end: '2026-06-30' }] })
    expect(fiscalYearEndMonthOn('2024-02-01', long)).toBe(6)
  })

  it('falls back on the settings month before the first recorded year', () => {
    const later = makeSettings({ fiscal_year_start_month: 5, fiscal_years: [{ start: '2026-03-14', end: '2026-12-31' }] })
    expect(fiscalYearEndMonthOn('2025-08-01', later)).toBe(4)
  })

  it('is December for a form bound to the calendar year, whatever a stored year says', () => {
    expect(fiscalYearEndMonthOn('2026-03-01', BROKEN_ENSKILD_FIRMA)).toBe(12)
  })
})

describe('deadline schedule: extended first räkenskapsår with moms from mid-quarter (crm#1278)', () => {
  const october = new Date(2026, 9, 16)

  it('shows only the first real momsdeklaration, no obligation for a räkenskapsår 2026', () => {
    const settings = makeSettings({ fiscal_years: EXTENDED_FIRST_YEAR })
    // Q4 2026 is the first quarter the company existed in (12 February,
    // SFL 26 kap.). Q1 2027 is outside the six-month recurring horizon on
    // this date and arrives later; the first årsstämma, årsredovisning and
    // INK2 fall in 2028, outside the twelve-month annual horizon.
    expect(keys(settings, [2026, 2027], october)).toEqual(['moms_quarterly:2026-Q4:2027-02-12'])
  })

  it('reproduces the five rows the ticket reported without the recorded räkenskapsår', () => {
    const settings = makeSettings({ fiscal_years: [] })
    expect(keys(settings, [2026, 2027], october)).toEqual([
      'arsredovisning:2026:2027-08-02',
      'arsstamma:2026:2027-06-30',
      'inkomstdeklaration_ab:2026:2027-08-02',
      'moms_quarterly:2026-Q3:2026-11-12',
      'moms_quarterly:2026-Q4:2027-02-12',
    ])
  })

  it('dates the first year-end obligations from the real end of the extended year', () => {
    const settings = makeSettings({ fiscal_years: EXTENDED_FIRST_YEAR })
    const result = keys(settings, [2027, 2028], new Date(2027, 11, 1))
    expect(result).toEqual(expect.arrayContaining([
      'arsstamma:2027:2028-06-30',
      'arsredovisning:2027:2028-07-31',
      'inkomstdeklaration_ab:2027:2028-08-01',
    ]))
    expect(result.some((key) => /^(arsstamma|arsredovisning|inkomstdeklaration_ab):2026:/.test(key))).toBe(false)
  })

  it('declares helårsmoms once for the whole extended year', () => {
    const yearly = makeSettings({ moms_period: 'yearly', fiscal_years: EXTENDED_FIRST_YEAR })
    expect(keys(yearly, [2026, 2027], october).filter((key) => key.startsWith('moms_yearly:'))).toEqual([])
    expect(keys(yearly, [2027, 2028], new Date(2027, 11, 1))).toContain('moms_yearly:2027:2028-08-17')
  })

  it('drops the monthly declaration for the month before the company existed', () => {
    const monthly = makeSettings({ moms_period: 'monthly', fiscal_years: EXTENDED_FIRST_YEAR })
    const result = keys(monthly, [2026, 2027], october)
    expect(result.some((key) => key.startsWith('moms_monthly:2026-09:'))).toBe(false)
    // October 2026 is due 12 December, a Saturday: next banking day.
    expect(result).toContain('moms_monthly:2026-10:2026-12-14')
  })
})

describe('deadline schedule: short first räkenskapsår', () => {
  // Registered 10 March 2026, first räkenskapsår shortened to 31 December.
  const settings = makeSettings({
    moms_period: 'monthly',
    fiscal_years: [{ start: '2026-03-10', end: '2026-12-31' }],
  })

  it('has no obligations for the year before the company existed', () => {
    const result = keys(settings, [2026, 2027], new Date(2026, 2, 15))
    expect(result.some((key) => key.includes(':2025:'))).toBe(false)
    expect(result.some((key) => key.startsWith('moms_monthly:2026-02:'))).toBe(false)
    expect(result).toContain('moms_monthly:2026-03:2026-05-12')

    const withoutPeriods = keys({ ...settings, fiscal_years: [] }, [2026, 2027], new Date(2026, 2, 15))
    expect(withoutPeriods).toEqual(expect.arrayContaining([
      'arsstamma:2025:2026-06-30',
      'moms_monthly:2026-02:2026-04-13',
    ]))
  })

  it('dates the short year itself on the ordinary schedule', () => {
    expect(keys(settings, [2026, 2027], new Date(2026, 11, 1))).toEqual(expect.arrayContaining([
      'arsstamma:2026:2027-06-30',
      'arsredovisning:2026:2027-08-02',
      'inkomstdeklaration_ab:2026:2027-08-02',
    ]))
  })
})

describe('deadline schedule: ordinary räkenskapsår are unchanged', () => {
  const allTypes = {
    moms_period: 'quarterly' as const,
    preliminary_tax_monthly: 5000,
    employer_registered: true,
    fyllnadsinbetalning_enabled: true,
    kontrolluppgifter_enabled: true,
  }

  it('calendar year: recorded years give exactly the twelve-month schedule', () => {
    const from = new Date(2026, 9, 16)
    const recorded = makeSettings({
      ...allTypes,
      fiscal_years: [
        { start: '2025-01-01', end: '2025-12-31' },
        { start: '2026-01-01', end: '2026-12-31' },
      ],
    })
    expect(keys(recorded, [2026, 2027], from)).toEqual(keys(makeSettings({ ...allTypes, fiscal_years: [] }), [2026, 2027], from))
  })

  it('calendar year onboarded with only the current year still shows the previous year', () => {
    // A company that kept its books elsewhere until 2026: its 2025 årsstämma,
    // årsredovisning and INK2 are real obligations.
    const from = new Date(2026, 1, 1)
    const recorded = makeSettings({ ...allTypes, fiscal_years: [{ start: '2026-01-01', end: '2026-12-31' }] })
    const result = keys(recorded, [2026, 2027], from)
    expect(result).toEqual(keys(makeSettings({ ...allTypes, fiscal_years: [] }), [2026, 2027], from))
    expect(result).toEqual(expect.arrayContaining([
      'arsstamma:2025:2026-06-30',
      'arsredovisning:2025:2026-07-31',
      'inkomstdeklaration_ab:2025:2026-08-03',
      'fyllnadsinbetalning:2025-rest:2026-05-04',
    ]))
  })

  it('broken räkenskapsår May-April: recorded years give exactly the twelve-month schedule', () => {
    const from = new Date(2026, 9, 16)
    const broken = { ...allTypes, fiscal_year_start_month: 5 }
    const twoYears = makeSettings({
      ...broken,
      fiscal_years: [
        { start: '2025-05-01', end: '2026-04-30' },
        { start: '2026-05-01', end: '2027-04-30' },
      ],
    })
    const currentOnly = makeSettings({ ...broken, fiscal_years: [{ start: '2026-05-01', end: '2027-04-30' }] })
    const schedule = keys(makeSettings({ ...broken, fiscal_years: [] }), [2026, 2027], from)

    expect(keys(twoYears, [2026, 2027], from)).toEqual(schedule)
    expect(keys(currentOnly, [2026, 2027], from)).toEqual(schedule)
    expect(schedule).toEqual(expect.arrayContaining([
      // 31 October 2026 is a Saturday: next banking day.
      'arsstamma:2025/2026:2026-11-02',
      'arsredovisning:2025/2026:2026-11-30',
      'inkomstdeklaration_ab:2025/2026:2026-12-01',
    ]))
  })
})

describe('findSettingsWithStaleUpcomingDeadlines', () => {
  const from = new Date(2026, 9, 16)
  const years = [2026, 2027]
  // The five rows the ticket's company had stored.
  const TICKET_ROWS = [
    'moms_quarterly:2026-Q3:2026-11-12',
    'moms_quarterly:2026-Q4:2027-02-12',
    'arsstamma:2026:2027-06-30',
    'arsredovisning:2026:2027-08-02',
    'inkomstdeklaration_ab:2026:2027-08-02',
  ]
  const company = { company_id: 'company-1', ...makeSettings({ fiscal_years: EXTENDED_FIRST_YEAR }) }

  it('flags a company holding rows for obligations that never existed', () => {
    const rows = rowsFor('company-1', TICKET_ROWS)
    expect(findSettingsWithStaleUpcomingDeadlines([company], rows, years, from)).toEqual([company])
    // Nothing is missing, which is why the old one-sided check never repaired it.
    expect(findSettingsMissingUpcomingDeadlines([company], rows, years, from)).toEqual([])
  })

  it('stops flagging once the rows match the schedule (no nightly loop)', () => {
    const rows = rowsFor('company-1', getExpectedUpcomingDeadlineKeys(toDeadlineSettings(company), years, from))
    expect(findSettingsWithStaleUpcomingDeadlines([company], rows, years, from)).toEqual([])
    expect(findSettingsMissingUpcomingDeadlines([company], rows, years, from)).toEqual([])
  })

  it('leaves completed and dismissed rows alone: regeneration never replaces them', () => {
    const completed = rowsFor('company-1', TICKET_ROWS.slice(2), { is_completed: true })
    const dismissed = rowsFor('company-1', TICKET_ROWS.slice(0, 1), { dismissed_at: '2026-10-16T10:00:00Z' })
    const current = rowsFor('company-1', ['moms_quarterly:2026-Q4:2027-02-12'])
    expect(findSettingsWithStaleUpcomingDeadlines(
      [company], [...completed, ...dismissed, ...current], years, from,
    )).toEqual([])
  })

  it('ignores past rows and ROT/RUT payout rows, which regeneration cannot reproduce from settings', () => {
    const rows = [
      ...rowsFor('company-1', ['moms_quarterly:2026-Q4:2027-02-12']),
      ...rowsFor('company-1', ['moms_quarterly:2026-Q2:2026-08-17']),
      ...rowsFor('company-1', ['rot_rut_begaran:2026:2027-02-01']),
    ]
    expect(findSettingsWithStaleUpcomingDeadlines([company], rows, years, from)).toEqual([])
  })

  it('does not flag an ordinary calendar-year company whose rows match the schedule', () => {
    const ordinary = {
      company_id: 'company-2',
      ...makeSettings({
        preliminary_tax_monthly: 5000,
        fiscal_years: [{ start: '2026-01-01', end: '2026-12-31' }],
      }),
    }
    const rows = rowsFor('company-2', getExpectedUpcomingDeadlineKeys(toDeadlineSettings(ordinary), years, from))
    expect(findSettingsWithStaleUpcomingDeadlines([ordinary], rows, years, from)).toEqual([])
  })
})

describe('backfillMissingTaxDeadlines: rows for obligations that never existed', () => {
  /**
   * Table-routed mock: paginated reads (.range) answer from `tables`; the
   * generator's own deadline reads answer empty; inserts are recorded.
   */
  function makeSupabase(tables: Record<string, unknown[]>) {
    const inserts: Array<Array<Record<string, unknown>>> = []
    const from = vi.fn((table: string) => {
      const chain: Record<string, unknown> = {}
      let deleting = false
      for (const method of ['eq', 'is', 'gte', 'lte', 'or', 'not', 'order']) {
        chain[method] = vi.fn(() => chain)
      }
      chain.select = vi.fn(() => (deleting ? Promise.resolve({ data: [], error: null }) : chain))
      chain.range = vi.fn(async () => ({ data: tables[table] ?? [], error: null }))
      chain.insert = vi.fn((rows: Array<Record<string, unknown>>) => {
        inserts.push(rows)
        return { select: vi.fn(async () => ({ data: rows.map((_, i) => ({ id: `new-${i}` })), error: null })) }
      })
      chain.delete = vi.fn(() => {
        deleting = true
        return chain
      })
      chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve)
      return chain
    })
    // The replacement of a company's set (replace_system_tax_deadlines).
    const rpc = vi.fn(async (_name: string, args: { p_rows: Array<Record<string, unknown>> }) => {
      if (args.p_rows.length > 0) inserts.push(args.p_rows)
      return { data: [{ created: args.p_rows.length, deleted: 0 }], error: null }
    })
    return { supabase: { from, rpc } as unknown as SupabaseClient, inserts }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 16, 12))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('regenerates the company holding ghost rows and leaves a matching company alone', async () => {
    const { fiscal_years: _fy, tax_assessment_notices: _tan, ...rawSettings } = makeSettings()
    const ordinaryKeys = getExpectedUpcomingDeadlineKeys(
      makeSettings({ fiscal_years: [{ start: '2026-01-01', end: '2026-12-31' }] }),
      [2026, 2027],
      new Date(2026, 9, 16, 12),
    )
    const { supabase, inserts } = makeSupabase({
      company_settings: [
        { company_id: 'company-1', ...rawSettings },
        { company_id: 'company-2', ...rawSettings },
      ],
      fiscal_periods: [
        { company_id: 'company-1', period_start: '2026-10-12', period_end: '2027-12-31' },
        { company_id: 'company-2', period_start: '2026-01-01', period_end: '2026-12-31' },
      ],
      deadlines: [
        ...rowsFor('company-1', [
          'moms_quarterly:2026-Q3:2026-11-12',
          'moms_quarterly:2026-Q4:2027-02-12',
          'arsstamma:2026:2027-06-30',
          'arsredovisning:2026:2027-08-02',
          'inkomstdeklaration_ab:2026:2027-08-02',
        ]),
        ...rowsFor('company-2', ordinaryKeys),
      ],
      tax_assessment_notices: [],
    })

    const result = await backfillMissingTaxDeadlines(supabase)

    expect(result).toMatchObject({ companiesScanned: 2, companiesRepaired: 1 })
    expect(inserts).toHaveLength(1)
    expect(inserts[0].map((row) => `${row.company_id}:${row.tax_deadline_type}:${row.tax_period}`))
      .toEqual(['company-1:moms_quarterly:2026-Q4'])
  })

  it('regenerates a declared first year holding the inkomstdeklaration of a year before it', async () => {
    vi.setSystemTime(new Date(2026, 10, 10, 12))
    const { fiscal_years: _fy, tax_assessment_notices: _tan, ...rawSettings } = makeSettings()
    // The rows the schedule wrote while it assumed a year April-March before.
    const heldKeys = getExpectedUpcomingDeadlineKeys(
      makeSettings({ fiscal_years: [{ start: '2026-04-01', end: '2026-12-31' }] }),
      [2026, 2027],
      new Date(2026, 10, 10, 12),
    )
    expect(heldKeys).toContain('inkomstdeklaration_ab:2025/2026:2026-12-01')
    const { supabase, inserts } = makeSupabase({
      company_settings: [{ company_id: 'company-1', ...rawSettings }],
      fiscal_periods: [
        { company_id: 'company-1', name: 'Första räkenskapsåret 2026', period_start: '2026-04-01', period_end: '2026-12-31' },
      ],
      deadlines: rowsFor('company-1', heldKeys),
      tax_assessment_notices: [],
    })

    const result = await backfillMissingTaxDeadlines(supabase)

    expect(result).toMatchObject({ companiesScanned: 1, companiesRepaired: 1 })
    expect(inserts).toHaveLength(1)
    const written = inserts[0].map((row) => `${row.tax_deadline_type}:${row.tax_period}`)
    expect(written).not.toContain('inkomstdeklaration_ab:2025/2026')
    expect(written).toContain('inkomstdeklaration_ab:2026')
  })
})

describe('fiscalYearForDeadlines', () => {
  const row = (name: string | null) => ({ name, period_start: '2026-04-01', period_end: '2026-12-31' })

  it('reads the name a first räkenskapsår gets at company creation as declared first', () => {
    expect(fiscalYearForDeadlines(row('Första räkenskapsåret 2026'))).toEqual({
      start: '2026-04-01',
      end: '2026-12-31',
      declaredFirst: true,
    })
    expect(fiscalYearForDeadlines(row('Första räkenskapsåret 2026/2027')).declaredFirst).toBe(true)
  })

  it('reads every other name, a renamed first year included, as an ordinary year', () => {
    for (const name of ['Räkenskapsår 2026', 'FY 2026', 'Mitt första år', null]) {
      expect(fiscalYearForDeadlines(row(name))).toEqual({ start: '2026-04-01', end: '2026-12-31' })
    }
  })
})

describe('deadline schedule: a first räkenskapsår declared at creation that starts on the 1st', () => {
  // An AB whose creator said it is in its first year, April to December,
  // quarterly moms: no räkenskapsår ended in March before it.
  const declared = makeSettings({
    fiscal_years: [{ start: '2026-04-01', end: '2026-12-31', declaredFirst: true }],
  })
  const undeclared = makeSettings({ fiscal_years: [{ start: '2026-04-01', end: '2026-12-31' }] })

  it('has no inkomstdeklaration for a räkenskapsår before the first one', () => {
    const from = new Date(2026, 10, 10)
    expect(keys(undeclared, [2026, 2027], from)).toContain('inkomstdeklaration_ab:2025/2026:2026-12-01')

    const result = keys(declared, [2026, 2027], from)
    expect(result.some((key) => key.includes(':2025/2026:'))).toBe(false)
    expect(result).toEqual(expect.arrayContaining([
      'inkomstdeklaration_ab:2026:2027-08-02',
      'arsredovisning:2026:2027-08-02',
      'arsstamma:2026:2027-06-30',
    ]))
  })

  it('has no momsdeklaration for the quarter before the first year began', () => {
    const from = new Date(2026, 3, 2)
    expect(keys(undeclared, [2026, 2027], from)).toContain('moms_quarterly:2026-Q1:2026-05-12')

    const result = keys(declared, [2026, 2027], from)
    expect(result.some((key) => key.startsWith('moms_quarterly:2026-Q1:'))).toBe(false)
    expect(result).toContain('moms_quarterly:2026-Q2:2026-08-17')
  })
})
