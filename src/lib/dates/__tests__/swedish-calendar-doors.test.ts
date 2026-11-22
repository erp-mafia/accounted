/**
 * Today, this month and this year are the Swedish calendar's on every door.
 * The process runs in UTC as on Vercel, and the clock stands at 00:30 on New
 * Year's Day in Sweden, still 31 December in UTC: the two night hours in which
 * a UTC or process-zone read answers last year.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createReskontraClient, type ReskontraTables } from '@/tests/reskontra-rpc-port'
import { createTableMockSupabase } from '@/tests/helpers'
import { computeFiscalPeriod } from '@/lib/company/compute-fiscal-period'
import { getCurrentFiscalYearStart, getPreviousFiscalYearStart } from '@/lib/company/fiscal-year'
import { currentVatPeriod, mostRecentEndedVatPeriod } from '@/lib/vat/period-defaults'
import { nextRunPeriod, runPeriodChoices } from '@/lib/salary/next-run-period'
import { isSalaryRunLate } from '@/lib/worklist/resume'
import { countReconciliationDue } from '@/lib/worklist/categories'
import { resolvePeriodPreset } from '@/lib/byra/kpi-aggregate'
import { listRuleMatches } from '@/lib/rules/service'
import { parseLedgerAsOfDate } from '@/lib/reports/ledger-as-of'
import { PAYROLL_RATES_DUE, requiredYears } from '@/lib/salary/rates-calendar'
import { expandPersonnummerTo12 } from '@/lib/salary/personnummer-format'
import { generateTaxDeadlinesForUser } from '@/lib/tax/deadline-generator'
import type { CompanySettingsForDeadlines } from '@/lib/tax/deadline-config'
import { buildSIEOpeningBalanceEntry } from '@/lib/import/sie-import'
import { validateSIEFile } from '@/lib/import/sie-parser'
import { OpeningBalancesFieldsSchema } from '@/lib/api/schemas'
import { exchangeRateDate } from '@/lib/currency/riksbanken'
import { toRedovisare12 } from '@/lib/invariants/org-number'
import { buildInfoSru } from '@/lib/reports/sru/envelope'
import { buildSandboxVatDeadline } from '@/app/api/sandbox/seed/vat-deadline'
import { resolveSandboxSalaryPeriods } from '@/app/api/sandbox/seed/salary'
import { vatReview } from '@/lib/agent/intents/vat-review'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'
import { todayIsoStockholm } from '@/lib/dates/iso'

const NEW_YEAR_NIGHT = new Date('2026-12-31T23:30:00Z')
const AB = { fiscal_year_start_month: 1, entity_type: 'aktiebolag' as const }
const DEADLINE_SETTINGS = { ...AB, moms_period: 'monthly', vat_registered: true, tax_assessment_notices: [] } as unknown as CompanySettingsForDeadlines

beforeAll(() => {
  vi.stubEnv('TZ', 'UTC')
})
afterAll(() => {
  vi.unstubAllEnvs()
})
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NEW_YEAR_NIGHT)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the process really is on UTC and it really is New Year in Sweden', () => {
  it('sets the stage', () => {
    expect(new Date().getTimezoneOffset()).toBe(0)
    expect(NEW_YEAR_NIGHT.getFullYear()).toBe(2026)
    expect(todayIsoStockholm(NEW_YEAR_NIGHT)).toBe('2027-01-01')
  })
})

describe('this year', () => {
  it('computeFiscalPeriod, the first period of the v1 and MCP doors', () => {
    expect(computeFiscalPeriod(AB)).toMatchObject({ startStr: '2027-01-01', endStr: '2027-12-31' })
  })

  it('the fiscal year start', () => {
    expect(getCurrentFiscalYearStart(AB, NEW_YEAR_NIGHT)).toBe('2027-01-01')
    expect(getPreviousFiscalYearStart(AB, NEW_YEAR_NIGHT)).toBe('2026-01-01')
  })

  it('the ledger as-of year tolerance', () => {
    expect(parseLedgerAsOfDate('2028-06-30', NEW_YEAR_NIGHT)).toEqual({ ok: true, asOfDate: '2028-06-30' })
  })

  it('the cutover year of opening balances takes the new year', () => {
    const parsed = OpeningBalancesFieldsSchema.safeParse({
      employee_id: '6f1c0a52-3b7e-4c1d-9a8e-2b4d5e6f7a81',
      cutover_date: '2027-01-01',
      ytd_gross: 0,
      ytd_tax: 0,
    })
    const issues = parsed.success ? [] : parsed.error.issues.map((issue) => issue.path[0])
    expect(issues).not.toContain('cutover_date')
  })

  it('the VAT review of no period names is of the Swedish year', async () => {
    const { supabase } = createTableMockSupabase({ company_settings: { data: { moms_period: 'quarterly' } } } as never)
    const captured = await vatReview.capture({} as never, { supabase, companyId: 'company-1' } as never)
    expect((captured as { period: { year: number } }).period.year).toBe(2027)
  })

  it('a ten-digit redovisare born in the two-digit year we are in is this century', () => {
    expect(toRedovisare12('2701011234', 'enskild_firma')).toBe('202701011234')
  })

  it('the demo company of the year', () => {
    expect(resolveSandboxSalaryPeriods(NEW_YEAR_NIGHT).booked.year).toBe(2027)
    expect(buildSandboxVatDeadline(NEW_YEAR_NIGHT).period).toContain('2027')
  })

  it('the years the rate tables must cover', () => {
    expect(requiredYears(PAYROLL_RATES_DUE, NEW_YEAR_NIGHT)[0]).toBe(2027)
  })

  it('the rule matches of this year', async () => {
    const { supabase, findCall } = createTableMockSupabase({ transactions: { data: [] } } as never)
    const rule = { counterparty_name: 'Hyresvärden', counterparty_aliases: [] }
    await listRuleMatches(supabase as never, 'company-1', rule as never, NEW_YEAR_NIGHT)
    expect(findCall('transactions', 'gte')).toEqual(['date', '2027-01-01'])
  })

  it('the tax deadline window opens from the Swedish year', async () => {
    const { supabase, findCall } = createTableMockSupabase({ deadlines: { data: [] } } as never)
    await generateTaxDeadlinesForUser(supabase as never, 'company-1', { ...DEADLINE_SETTINGS, fiscal_years: [] })
    // The window is last year, this year and next (deadlineWindowYears), and
    // the completed-row floor is a year before its first: 2026 to 2028 from
    // the Swedish 2027 gives 2025-01-01, the UTC 2026 would give 2024-01-01.
    expect(findCall('deadlines', 'gte')).toEqual(['due_date', '2025-01-01'])
  })
})

describe('this month', () => {
  it('the VAT period running and the last one ended', () => {
    expect(currentVatPeriod('monthly', NEW_YEAR_NIGHT)).toEqual({ year: 2027, period: 1 })
    expect(currentVatPeriod('yearly', NEW_YEAR_NIGHT)).toEqual({ year: 2027, period: 1 })
    expect(mostRecentEndedVatPeriod('quarterly', NEW_YEAR_NIGHT)).toEqual({ year: 2026, period: 4 })
    expect(mostRecentEndedVatPeriod('yearly', NEW_YEAR_NIGHT)).toEqual({ year: 2026, period: 1 })
  })

  it('the next salary run with no run before it, and the start menu', () => {
    expect(nextRunPeriod([], NEW_YEAR_NIGHT)).toEqual({ period_year: 2027, period_month: 1 })
    expect(runPeriodChoices([], NEW_YEAR_NIGHT)[0]).toMatchObject({ period_year: 2027, period_month: 1 })
  })

  it('a salary run two Swedish months back is late', () => {
    expect(isSalaryRunLate(2026, 11, NEW_YEAR_NIGHT)).toBe(true)
  })

  it('the KPI presets end on the Swedish day', () => {
    expect(resolvePeriodPreset('month', NEW_YEAR_NIGHT).range).toEqual({ fromDate: '2027-01-01', toDate: '2027-01-01' })
    expect(resolvePeriodPreset('ytd', NEW_YEAR_NIGHT).range).toEqual({ fromDate: '2027-01-01', toDate: '2027-01-01' })
  })

  it('the reconciliation nudge wants the Swedish month before', async () => {
    const { supabase } = createTableMockSupabase({
      account_reconciliations: { data: [{ account_key: 'bank:a', through_date: '2026-11-30', reopened_at: null }] },
      cash_accounts: { data: [{ id: 'a', iban: 'SE1', currency: 'SEK', updated_at: '2026-01-01' }] },
      transactions: { data: [], count: 0 },
    } as never)
    expect(await countReconciliationDue(supabase as never, 'company-1', NEW_YEAR_NIGHT)).toBe(1)
  })
})

describe('today', () => {
  it('the Riksbanken rate of no date is read for today, a date asked for stays', () => {
    expect(exchangeRateDate()).toBe('2027-01-01')
    expect(exchangeRateDate(new Date('2026-03-01'))).toBe('2026-03-01')
  })

  it('a SIE opening balance with no fiscal year in the file is dated today', () => {
    const parsed = {
      header: { fiscalYears: [] },
      stats: { fiscalYearStart: null },
      openingBalances: [],
      closingBalances: [],
      vouchers: [],
    }
    const mapped = new Map([['1930', '1930'], ['2099', '2099']])
    const balanced = {
      ...parsed,
      openingBalances: [
        { yearIndex: 0, account: '1930', amount: 100 },
        { yearIndex: 0, account: '2099', amount: -100 },
      ],
    }
    const entry = buildSIEOpeningBalanceEntry('period-1', balanced as never, mapped, 0, 'A', '2099')
    expect(entry?.entry_date).toBe('2027-01-01')
  })

  it("a SIE year that ended yesterday has ended, on New Year's night", () => {
    const parsed = {
      header: { sieType: 4, flagga: 0, companyName: 'Test AB', currency: 'SEK', fiscalYears: [{ yearIndex: 0, start: '2026-01-01', end: '2026-12-31' }] },
      accounts: [{ number: '1930', name: 'Bank' }, { number: '3001', name: 'Försäljning' }],
      openingBalances: [],
      closingBalances: [],
      resultBalances: [],
      dimensions: [],
      dimensionValues: [],
      vouchers: [{ series: 'A', number: 1, date: new Date('2026-06-01'), description: 'Försäljning', lines: [{ account: '1930', amount: 100 }, { account: '3001', amount: -100 }] }],
      stats: {},
      issues: [],
    }
    const { warnings } = validateSIEFile(parsed as never)
    expect(warnings.some((warning) => /omföring/i.test(warning))).toBe(true)
  })

  it('an SRU file is stamped on the Swedish date and clock', () => {
    const info = buildInfoSru({ identity12: '165566778899', name: 'Test AB' } as never, NEW_YEAR_NIGHT)
    expect(info).toContain('#SKAPAD 20270101 003000')
  })

  it('a ten-digit personnummer born today is this century', () => {
    expect(expandPersonnummerTo12('270101-1234', NEW_YEAR_NIGHT)).toBe('202701011234')
  })

  describe('the reskontra as of yesterday is history', () => {
    let tables: ReskontraTables
    const { supabase, calls } = createReskontraClient(() => tables, () => ({}))
    const argsOf = (name: string) => calls.find((c) => c.name === name)?.args as { p_as_of_date: string | null } | undefined

    beforeEach(() => {
      calls.length = 0
      tables = { invoices: [], supplier_invoices: [] }
    })

    it('generateARLedger reconstructs 31 December', async () => {
      await generateARLedger(supabase, 'company-1', '2026-12-31')
      expect(argsOf('get_ar_ledger_invoices')?.p_as_of_date).toBe('2026-12-31')
    })

    it('generateSupplierLedger reconstructs 31 December', async () => {
      await generateSupplierLedger(supabase as unknown as SupabaseClient, 'company-1', '2026-12-31')
      expect(calls.map((c) => c.args).some((args) => (args as { p_as_of_date?: string | null }).p_as_of_date === '2026-12-31')).toBe(true)
    })
  })
})
