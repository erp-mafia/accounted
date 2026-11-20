import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn().mockResolvedValue({ rows: [], isBalanced: true, totalDebit: 0, totalCredit: 0 }),
}))

import { createRowsMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { Logger } from '@/lib/logger'
import type { FiscalPeriod } from '@/types'
import { assertPeriodExternallyClosable } from '@/lib/core/bookkeeping/period-service'
import { createFiscalPeriod, updateFiscalPeriod } from '@/lib/core/bookkeeping/fiscal-year-service'
import { validateYearEndReadiness } from '@/lib/core/bookkeeping/year-end-service'
import { precheckFiscalPeriod } from '@/lib/import/sie-import'
import { computeFiscalPeriod } from '@/lib/company/compute-fiscal-period'
import { runPreflightChecks } from '@/lib/bokslut/ixbrl/validate/rules'
import { makeInput } from '@/lib/bokslut/ixbrl/__tests__/fixtures'
import { closableImportedYears } from '@/lib/onboarding/closable-imported-years'
import { pickCurrentPeriod } from '@/lib/byra/kpi-aggregate'
import { resolveInitialFiscalScope } from '@/lib/reference-data/fiscal-scope'
import { vatFilingDateProblem } from '@/lib/vat/filing-record'

const COMPANY = 'company-1'
const USER = 'user-1'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as Logger

const year = (id: string, start: string, end: string, overrides: Record<string, unknown> = {}) => ({
  id,
  company_id: COMPANY,
  name: id,
  period_start: start,
  period_end: end,
  is_closed: false,
  locked_at: null,
  closed_externally: false,
  closing_entry_id: null,
  opening_balances_set: false,
  previous_period_id: null,
  ...overrides,
})

const company = (entityType: string, periods: ReturnType<typeof year>[]) =>
  createRowsMockSupabase({
    fiscal_periods: periods,
    companies: [{ id: COMPANY, entity_type: entityType }],
    company_settings: [{ company_id: COMPANY, entity_type: entityType, bookkeeping_locked_through: null }],
  }).supabase as never

const ctx = (supabase: never) => ({ supabase, companyId: COMPANY, userId: USER, log })

beforeEach(() => {
  eventBus.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a year has ended only when its last day has passed in Sweden', () => {
  const lastDay = '2026-12-31'
  const dayAfter = '2027-01-01'
  const fy2026 = () => year('fy2026', '2026-01-01', lastDay)

  const onDay = (day: string) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${day}T10:00:00Z`))
  }

  it.each([
    [lastDay, true],
    [dayAfter, false],
  ])('year-end readiness on %s', async (day, refused) => {
    onDay(day)
    const result = await validateYearEndReadiness(company('aktiebolag', [fy2026()]), COMPANY, USER, 'fy2026')
    expect(result.blockers.some((b) => b.code === 'PERIOD_NOT_ENDED')).toBe(refused)
  })

  it.each([
    [lastDay, 'FISCAL_PERIOD_CLOSE_EXTERNAL_NOT_ENDED'],
    [dayAfter, undefined],
  ])('klarmarkera on %s', async (day, code) => {
    onDay(day)
    const closing = assertPeriodExternallyClosable(
      company('aktiebolag', [fy2026()]),
      COMPANY,
      fy2026() as unknown as FiscalPeriod,
    )
    const refusal = await closing.then(() => undefined, (error: { code?: string }) => error.code)
    expect(refusal).toBe(code)
  })

  it('reads the same at the iXBRL preflight', () => {
    const input = makeInput()
    input.period.end = lastDay
    expect(runPreflightChecks(input, lastDay).issues.map((i) => i.code)).toContain('1015')
    expect(runPreflightChecks(input, dayAfter).issues.map((i) => i.code)).not.toContain('1015')
  })

  it('reads the same on a VAT filing', () => {
    const filing = { periodType: 'yearly', year: 2026, period: 1, filedOn: lastDay } as const
    expect(vatFilingDateProblem(filing, lastDay, 12)).toBe('VAT_FILING_PERIOD_NOT_ENDED')
    expect(vatFilingDateProblem({ ...filing, filedOn: dayAfter }, dayAfter, 12)).toBeNull()
  })

  it('reads the same among the imported years to klarmarkera', () => {
    const years = [fy2026(), year('fy2027', '2027-01-01', '2027-12-31')] as never[]
    expect(closableImportedYears(years, lastDay)).toEqual([])
    expect(closableImportedYears(years, dayAfter)).toHaveLength(1)
  })

  it('reads the same in the year picker', () => {
    const scoped = (today: string) =>
      resolveInitialFiscalScope(
        [year('fy2026', '2026-01-01', lastDay), year('fy2025', '2025-01-01', '2025-12-31')] as never,
        null,
        { preferLatestEnded: true, includeAllOption: false, today },
      )?.periodId
    expect(scoped(lastDay)).toBe('fy2025')
    expect(scoped(dayAfter)).toBe('fy2026')
  })

  it('reads the same in the byrå figures, where a year ending today is the one running', () => {
    const lite = [
      { id: 'a', period_start: '2025-01-01', period_end: '2025-12-31' },
      { id: 'b', period_start: '2027-01-01', period_end: '2027-12-31' },
    ]
    expect(pickCurrentPeriod(lite as never, '2025-12-31')?.id).toBe('a')
    expect(pickCurrentPeriod(lite as never, '2026-06-01')?.id).toBe('a')
  })
})

describe('a räkenskapsår is at most 18 months, counted one way', () => {
  it.each([
    ['2024-01-31', '2025-07-31', true],
    ['2024-03-31', '2025-09-30', true],
    ['2024-03-01', '2025-08-31', false],
    ['2024-03-15', '2025-08-31', false],
  ])('%s to %s on the iXBRL preflight', (start, end, over) => {
    const input = makeInput()
    input.period = { start, end }
    expect(runPreflightChecks(input, '2026-11-01').issues.some((issue) => issue.code === '1046')).toBe(over)
  })
})

describe('an enskild firma keeps the calendar year on every door', () => {
  const existing = () => [year('fy2026', '2026-01-01', '2026-12-31')]
  const input = (start: string, end: string) => ({ name: 'x', period_start: start, period_end: end })

  it('refuses a new year ending anywhere but 31 December', async () => {
    const outcome = await createFiscalPeriod(ctx(company('enskild_firma', existing())), input('2027-01-01', '2027-06-30'), {
      dryRun: true,
    })
    expect(outcome).toMatchObject({
      ok: false,
      code: 'FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR',
      details: { rule: 'end_31_december' },
    })
  })

  it('refuses a later year starting after 1 January', async () => {
    const outcome = await createFiscalPeriod(
      ctx(company('enskild_firma', [year('fy2026', '2026-01-01', '2026-06-30')])),
      input('2026-07-01', '2026-12-31'),
      { dryRun: true },
    )
    expect(outcome).toMatchObject({
      ok: false,
      code: 'FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR',
      details: { rule: 'start_1_january' },
    })
  })

  it('takes a first year from any day to 31 December, up to 18 months', async () => {
    const outcome = await createFiscalPeriod(ctx(company('enskild_firma', [])), input('2025-07-14', '2026-12-31'), {
      dryRun: true,
    })
    expect(outcome).toMatchObject({ ok: true, dryRun: true })
  })

  it('leaves an aktiebolag its broken year', async () => {
    const outcome = await createFiscalPeriod(ctx(company('aktiebolag', [])), input('2026-07-01', '2027-06-30'), {
      dryRun: true,
    })
    expect(outcome).toMatchObject({ ok: true, dryRun: true })
  })

  it('refuses the same year through the SIE door, before anything is written', async () => {
    const verdict = await precheckFiscalPeriod(company('enskild_firma', existing()), COMPANY, '2027-01-01', '2027-06-30')
    expect(verdict).toMatchObject({ verdict: 'invalid' })
    expect((verdict as { message: string }).message).toMatch(/31 december/)
  })

  it('refuses a broken year file for a new company too', async () => {
    const verdict = await precheckFiscalPeriod(company('enskild_firma', []), COMPANY, '2021-09-01', '2022-08-31')
    expect(verdict).toMatchObject({ verdict: 'invalid' })
  })

  it('does not count the empty seed the import deletes as a year before the file', async () => {
    const seed = [year('seed', '2025-01-01', '2025-12-31')]
    const verdict = await precheckFiscalPeriod(company('enskild_firma', seed), COMPANY, '2025-07-01', '2026-12-31')
    expect(verdict).toMatchObject({ verdict: 'create', replacesEmptyPeriodId: 'seed' })
  })

  it('still counts a year the import keeps', async () => {
    const kept = [year('kept', '2023-01-01', '2023-12-31'), year('seed', '2025-01-01', '2025-12-31')]
    const verdict = await precheckFiscalPeriod(company('enskild_firma', kept), COMPANY, '2025-07-01', '2026-12-31')
    expect(verdict).toMatchObject({ verdict: 'invalid' })
  })

  it('leaves the SIE door open for an aktiebolag on the same dates', async () => {
    const verdict = await precheckFiscalPeriod(company('aktiebolag', []), COMPANY, '2021-09-01', '2022-08-31')
    expect(verdict).toMatchObject({ verdict: 'create' })
  })

  it('stops a year-end before the closing entry when the next year would be refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2027-10-01T10:00:00Z'))
    const broken = [year('fy', '2026-09-01', '2027-08-31')]
    const result = await validateYearEndReadiness(company('enskild_firma', broken), COMPANY, USER, 'fy')
    expect(result.blockers.map((b) => b.code)).toContain('NEXT_PERIOD_NOT_CALENDAR_YEAR')
  })

  it('lets a calendar year through, and an aktiebolag on the same dates', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2027-10-01T10:00:00Z'))
    const calendar = await validateYearEndReadiness(
      company('enskild_firma', [year('fy', '2026-01-01', '2026-12-31')]),
      COMPANY,
      USER,
      'fy',
    )
    expect(calendar.blockers.map((b) => b.code)).not.toContain('NEXT_PERIOD_NOT_CALENDAR_YEAR')
    const aktiebolag = await validateYearEndReadiness(
      company('aktiebolag', [year('fy', '2026-09-01', '2027-08-31')]),
      COMPANY,
      USER,
      'fy',
    )
    expect(aktiebolag.blockers.map((b) => b.code)).not.toContain('NEXT_PERIOD_NOT_CALENDAR_YEAR')
  })

  it('reads the form off the company when the settings row has none', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2027-10-01T10:00:00Z'))
    const supabase = createRowsMockSupabase({
      company_settings: [{ company_id: COMPANY, entity_type: null, accounting_method: 'accrual' }],
      companies: [{ id: COMPANY, entity_type: 'enskild_firma' }],
      fiscal_periods: [year('fy', '2026-09-01', '2027-08-31')],
    }).supabase as never
    const result = await validateYearEndReadiness(supabase, COMPANY, USER, 'fy')
    expect(result.blockers.map((b) => b.code)).toContain('NEXT_PERIOD_NOT_CALENDAR_YEAR')
  })

  it('stops a year-end before the closing entry when a later year sits inside the next twelve months', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2025-10-01T10:00:00Z'))
    const later = [year('fy', '2024-01-01', '2024-12-31'), year('later', '2025-07-01', '2026-06-30')]
    const result = await validateYearEndReadiness(company('aktiebolag', later), COMPANY, USER, 'fy')
    const blocker = result.blockers.find((b) => b.code === 'NEXT_PERIOD_OVERLAPS')
    expect(blocker?.message).toContain('2025-07-01')
  })

  it('lets a year-end through when twelve months fit before a later year', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2027-10-01T10:00:00Z'))
    const later = [year('fy', '2024-01-01', '2024-12-31'), year('later', '2026-01-01', '2026-12-31')]
    const result = await validateYearEndReadiness(company('aktiebolag', later), COMPANY, USER, 'fy')
    expect(result.blockers.map((b) => b.code)).not.toContain('NEXT_PERIOD_OVERLAPS')
  })

  describe('with broken years already stored', () => {
    const stored = () => [year('fy', '2024-09-01', '2025-08-31')]

    it('still reads its own years through the SIE door', async () => {
      const verdict = await precheckFiscalPeriod(company('enskild_firma', stored()), COMPANY, '2024-09-01', '2025-08-31')
      expect(verdict).toEqual({ verdict: 'match', periodId: 'fy' })
    })

    it('still renames one', async () => {
      const outcome = await updateFiscalPeriod(ctx(company('enskild_firma', stored())), 'fy', { name: 'Nytt namn' }, {
        dryRun: true,
      })
      expect(outcome).toMatchObject({ ok: true, dryRun: true })
    })
  })

  it('keeps refusing a re-date, in the same words', async () => {
    const outcome = await updateFiscalPeriod(
      ctx(company('enskild_firma', existing())),
      'fy2026',
      { period_end: '2026-06-30' },
      { dryRun: true },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR' })
  })

  it('refuses a first year not ending 31 December at onboarding', () => {
    const computed = computeFiscalPeriod({
      entity_type: 'enskild_firma',
      is_first_fiscal_year: true,
      first_year_start: '2026-03-10',
      first_year_end: '2026-06-30',
    })
    expect(computed.error).toEqual(expect.stringMatching(/31 December/))
  })
})

describe('a year after a gap is not a first year', () => {
  it('still may not start mid-month on the create and SIE doors', async () => {
    const periods = () => [year('fy2023', '2023-01-01', '2023-12-31')]
    const created = await createFiscalPeriod(
      ctx(company('aktiebolag', periods())),
      { name: 'x', period_start: '2025-03-14', period_end: '2025-12-31' },
      { dryRun: true },
    )
    expect(created).toMatchObject({ ok: false, code: 'FISCAL_PERIOD_START_NOT_FIRST_OF_MONTH' })

    const verdict = await precheckFiscalPeriod(company('aktiebolag', periods()), COMPANY, '2025-03-14', '2025-12-31')
    expect(verdict).toMatchObject({ verdict: 'invalid' })
  })

  it('starts mid-month when no year starts before it, whatever comes later', async () => {
    const periods = () => [year('fy2025', '2025-01-01', '2025-12-31')]
    const created = await createFiscalPeriod(
      ctx(company('aktiebolag', periods())),
      { name: 'x', period_start: '2024-03-14', period_end: '2024-12-31' },
      { dryRun: true },
    )
    expect(created).toMatchObject({ ok: true, dryRun: true })

    const verdict = await precheckFiscalPeriod(company('aktiebolag', periods()), COMPANY, '2024-03-14', '2024-12-31')
    expect(verdict).toMatchObject({ verdict: 'create' })
  })
})
