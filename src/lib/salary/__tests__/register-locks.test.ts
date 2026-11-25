/**
 * Unit tests for lib/salary/register-locks.ts: which salary run reads a
 * register day, whether a write may touch it, and where a late day goes.
 *
 * The rule: a row is read by the run it is carried to (carried_to_run_id)
 * or else by the run whose deviation window holds its date. A run in review,
 * approved, paid or booked locks what it reads; draft runs and corrected
 * originals never lock. A new day on a date a paid, booked or declared run
 * read is a late day: written only with carried_to_run_id naming the next
 * run that is neither paid nor declared, a draft with the employee on it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  REGISTER_LOCKING_RUN_STATUSES,
  checkRegisterRangeDelete,
  planRegisterUpsert,
  registerRefusalMessageSv,
} from '@/lib/salary/register-locks'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

type Run = {
  id: string
  status: string
  period_year: number
  period_month: number
  deviation_period_start: string | null
  deviation_period_end: string | null
  agi_submitted_at: string | null
  corrects_run_id: string | null
}

function run(overrides: Partial<Run> & Pick<Run, 'id' | 'status' | 'period_year' | 'period_month'>): Run {
  return {
    deviation_period_start: null,
    deviation_period_end: null,
    agi_submitted_at: null,
    corrects_run_id: null,
    ...overrides,
  }
}

/** September pay month, calculated, created before the window columns existed. */
const REVIEW_LEGACY_SEPTEMBER = run({ id: 'run-sep', status: 'review', period_year: 2026, period_month: 9 })

/** October pay month, booked, reading September ("previous_month"). */
const BOOKED_OCTOBER_READS_SEPTEMBER = run({
  id: 'run-oct',
  status: 'booked',
  period_year: 2026,
  period_month: 10,
  deviation_period_start: '2026-09-01',
  deviation_period_end: '2026-09-30',
})

/** October, booked, reading October. */
const BOOKED_OCTOBER = run({
  id: 'run-oct',
  status: 'booked',
  period_year: 2026,
  period_month: 10,
  deviation_period_start: '2026-10-01',
  deviation_period_end: '2026-10-31',
})

/** November, a draft, reading November: the next run after October. */
const DRAFT_NOVEMBER = run({
  id: 'run-nov',
  status: 'draft',
  period_year: 2026,
  period_month: 11,
  deviation_period_start: '2026-11-01',
  deviation_period_end: '2026-11-30',
})

/** December, a draft. */
const DRAFT_DECEMBER = run({
  id: 'run-dec',
  status: 'draft',
  period_year: 2026,
  period_month: 12,
  deviation_period_start: '2026-12-01',
  deviation_period_end: '2026-12-31',
})

/** September, a draft: earlier than the October days. */
const DRAFT_SEPTEMBER = run({
  id: 'run-sep-draft',
  status: 'draft',
  period_year: 2026,
  period_month: 9,
  deviation_period_start: '2026-09-01',
  deviation_period_end: '2026-09-30',
})

/** The employee's payslip on the run that read the late days: paid monthly. */
const OCTOBER_SLIP = { data: [{ salary_run_id: 'run-oct', salary_type: 'monthly' }] }

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

const fromCalls = () =>
  (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
})

function upsert(
  dates: string[],
  opts: { carriedToRunId?: string; kind?: 'absence' | 'worked'; absenceType?: string } = {},
) {
  return planRegisterUpsert(supabase, COMPANY_ID, {
    kind: opts.kind ?? 'absence',
    employeeId: EMPLOYEE_ID,
    dates,
    absenceType: opts.kind === 'worked' ? undefined : (opts.absenceType ?? 'parental'),
    carriedToRunId: opts.carriedToRunId,
  })
}

function carriedTo(result: Awaited<ReturnType<typeof upsert>>): Record<string, string | null> | false {
  return result.ok && Object.fromEntries(result.plan.carriedTo)
}

describe('planRegisterUpsert: the window locks', () => {
  it('never queries for an empty date list', async () => {
    const result = await upsert([])
    expect(result).toEqual({ ok: true, plan: { carriedTo: new Map(), carriedReaderRunIds: [] } })
    expect(fromCalls()).toEqual([])
  })

  it('reads every run of the company and the days already registered on the key, literal selects', async () => {
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })
    await upsert(['2026-09-15'])

    expect(fromCalls()).toEqual(['salary_runs', 'salary_absence_days'])
    expect(REGISTER_LOCKING_RUN_STATUSES).toEqual(['review', 'approved', 'paid', 'booked'])
    expect(mock.findCalls('salary_runs', 'eq')).toEqual([['company_id', COMPANY_ID]])
    const selected = mock.findCall('salary_runs', 'select')?.[0] as string
    for (const column of [
      'id',
      'status',
      'period_year',
      'period_month',
      'deviation_period_start',
      'deviation_period_end',
      'agi_submitted_at',
      'corrects_run_id',
    ]) {
      expect(selected).toContain(column)
    }
    expect(mock.findCall('salary_absence_days', 'select')).toEqual(['absence_date, carried_to_run_id'])
    expect(mock.findCalls('salary_absence_days', 'eq')).toEqual([
      ['company_id', COMPANY_ID],
      ['employee_id', EMPLOYEE_ID],
      ['absence_type', 'parental'],
    ])
    expect(mock.findCall('salary_absence_days', 'in')).toEqual(['absence_date', ['2026-09-15']])
  })

  it('writes a day no locking run reads plainly, draft runs included', async () => {
    mock.enqueue({ data: [{ ...REVIEW_LEGACY_SEPTEMBER, status: 'draft' }] })
    mock.enqueue({ data: [] })
    const result = await upsert(['2026-09-15', '2026-09-16'])
    expect(carriedTo(result)).toEqual({ '2026-09-15': null, '2026-09-16': null })
  })

  it('a review run with a legacy NULL window locks its pay month: revert it', async () => {
    mock.enqueue({ data: [REVIEW_LEGACY_SEPTEMBER] })
    mock.enqueue({ data: [] })
    const result = await upsert(['2026-08-31', '2026-09-01', '2026-09-30', '2026-10-01'])
    expect(result).toEqual({
      ok: false,
      code: 'SALARY_REGISTER_DATES_LOCKED_BY_RUN',
      details: {
        salary_run_id: 'run-sep',
        status: 'review',
        period_year: 2026,
        period_month: 9,
        deviation_period_start: '2026-09-01',
        deviation_period_end: '2026-09-30',
        locked_dates: ['2026-09-01', '2026-09-30'],
        settled: false,
        reason: 'run_not_settled',
      },
    })
  })

  it('a booked run with a stored previous-month window holds those dates and not its pay month', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER_READS_SEPTEMBER] })
    mock.enqueue({ data: [] })
    const september = await upsert(['2026-09-10', '2026-10-10'])
    expect(september).toMatchObject({
      ok: false,
      details: { salary_run_id: 'run-oct', locked_dates: ['2026-09-10'], reason: 'late_day_needs_later_run' },
    })
  })

  it('a later run named does not let a day past a run in review: that run is reverted', async () => {
    mock.enqueue({ data: [REVIEW_LEGACY_SEPTEMBER, DRAFT_NOVEMBER] })
    mock.enqueue({ data: [] })
    const result = await upsert(['2026-09-15'], { carriedToRunId: 'run-nov' })
    expect(result).toMatchObject({ ok: false, details: { reason: 'run_not_settled', salary_run_id: 'run-sep' } })
  })

  it('a corrected original makes a new day in its window late; the days already there are its correction\'s', async () => {
    const runs = [
      { ...REVIEW_LEGACY_SEPTEMBER, id: 'run-sep-original', status: 'corrected' },
      { ...REVIEW_LEGACY_SEPTEMBER, id: 'run-sep-correction', status: 'review', corrects_run_id: 'run-sep-original' },
    ]
    mock.enqueue({ data: runs })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ salary_run_id: 'run-sep-original' }] }) // the original paid the employee
    const result = await upsert(['2026-09-15'])
    expect(result).toMatchObject({
      ok: false,
      details: { salary_run_id: 'run-sep-original', status: 'corrected', settled: true, reason: 'late_day_needs_later_run' },
    })
    expect(mock.findCalls('salary_run_employees', 'in')).toEqual([['salary_run_id', ['run-sep-original']]])

    mock.enqueue({ data: runs })
    mock.enqueue({ data: [{ absence_date: '2026-09-15', carried_to_run_id: null }] })
    const existing = await upsert(['2026-09-15'])
    expect(existing).toMatchObject({ ok: false, details: { salary_run_id: 'run-sep-correction', reason: 'run_not_settled' } })

    mock.enqueue({ data: [runs[0]] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ salary_run_id: 'run-sep-original' }] })
    const onlyOriginal = await upsert(['2026-09-15'])
    expect(onlyOriginal).toMatchObject({ ok: false, details: { reason: 'late_day_needs_later_run' } })
  })

  it('an employee the corrected original never paid has a new day in its window read by the correction, as before', async () => {
    const original = { ...DRAFT_NOVEMBER, status: 'corrected' }
    const correction = { ...DRAFT_NOVEMBER, id: 'run-nov-correction', corrects_run_id: 'run-nov' }
    mock.enqueue({ data: [original, correction, DRAFT_DECEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] }) // no payslip on the corrected November: added to the correction
    const draft = await upsert(['2026-11-10'], { absenceType: 'vab' })
    expect(carriedTo(draft)).toEqual({ '2026-11-10': null })

    mock.enqueue({ data: [original, { ...correction, status: 'review' }, DRAFT_DECEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [] })
    const review = await upsert(['2026-11-10'], { absenceType: 'vab' })
    expect(review).toMatchObject({ ok: false, details: { salary_run_id: 'run-nov-correction', reason: 'run_not_settled' } })
  })

  it('reads the payslips of every version in a chain of corrections and decides by the last that paid', async () => {
    mock.enqueue({
      data: [
        { ...DRAFT_NOVEMBER, status: 'corrected' },
        { ...DRAFT_NOVEMBER, id: 'run-nov-c1', status: 'corrected', corrects_run_id: 'run-nov' },
        { ...DRAFT_NOVEMBER, id: 'run-nov-c2', corrects_run_id: 'run-nov-c1' },
        DRAFT_DECEMBER,
      ],
    })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ salary_run_id: 'run-nov' }, { salary_run_id: 'run-nov-c1' }] })
    const result = await upsert(['2026-11-10'])
    expect(result).toMatchObject({ ok: false, details: { salary_run_id: 'run-nov-c1', reason: 'late_day_needs_later_run' } })
    expect(mock.findCalls('salary_run_employees', 'in')).toEqual([['salary_run_id', ['run-nov', 'run-nov-c1']]])
  })

  it('counts an employee paid by any version of the period: paid by the original, left off the first correction', async () => {
    mock.enqueue({
      data: [
        { ...DRAFT_NOVEMBER, status: 'corrected' },
        { ...DRAFT_NOVEMBER, id: 'run-nov-c1', status: 'corrected', corrects_run_id: 'run-nov' },
        { ...DRAFT_NOVEMBER, id: 'run-nov-c2', corrects_run_id: 'run-nov-c1' },
        DRAFT_DECEMBER,
      ],
    })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ salary_run_id: 'run-nov' }] })
    const result = await upsert(['2026-11-10'])
    expect(result).toMatchObject({ ok: false, details: { salary_run_id: 'run-nov', reason: 'late_day_needs_later_run' } })
  })

  it('surfaces a failed read of the corrected run\'s payslips as INTERNAL_ERROR', async () => {
    mock.enqueue({ data: [{ ...DRAFT_NOVEMBER, status: 'corrected' }] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: null, error: { message: 'boom' } })
    const result = await upsert(['2026-11-10'])
    expect(result).toEqual({ ok: false, code: 'INTERNAL_ERROR', details: { message: 'boom' } })
  })

  it('names the earliest run when several read the dates', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER_READS_SEPTEMBER, REVIEW_LEGACY_SEPTEMBER] })
    mock.enqueue({ data: [] })
    const result = await upsert(['2026-09-15'])
    expect(result).toMatchObject({ ok: false, details: { salary_run_id: 'run-sep' } })
  })

  it('surfaces a run lookup failure as INTERNAL_ERROR instead of allowing the write', async () => {
    mock.enqueue({ data: null, error: { message: 'boom' } })
    const result = await upsert(['2026-09-15'])
    expect(result).toEqual({ ok: false, code: 'INTERNAL_ERROR', details: { message: 'boom' } })
  })

  it('surfaces a register lookup failure as INTERNAL_ERROR', async () => {
    mock.enqueue({ data: [] })
    mock.enqueue({ data: null, error: { message: 'boom' } })
    const result = await upsert(['2026-09-15'])
    expect(result).toEqual({ ok: false, code: 'INTERNAL_ERROR', details: { message: 'boom' } })
  })
})

describe('planRegisterUpsert: late days', () => {
  it('refuses a new day on a date a booked run read and names the run it goes to', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER, DRAFT_DECEMBER] })
    mock.enqueue({ data: [] })
    const result = await upsert(['2026-10-19', '2026-10-20'])
    expect(result).toEqual({
      ok: false,
      code: 'SALARY_REGISTER_DATES_LOCKED_BY_RUN',
      details: {
        salary_run_id: 'run-oct',
        status: 'booked',
        period_year: 2026,
        period_month: 10,
        deviation_period_start: '2026-10-01',
        deviation_period_end: '2026-10-31',
        locked_dates: ['2026-10-19', '2026-10-20'],
        settled: true,
        reason: 'late_day_needs_later_run',
        later_salary_run: { salary_run_id: 'run-nov', status: 'draft', period_year: 2026, period_month: 11 },
      },
    })
  })

  it('a run with its AGI filed is settled even before it is paid', async () => {
    mock.enqueue({
      data: [{ ...BOOKED_OCTOBER, status: 'approved', agi_submitted_at: '2026-11-09T16:33:59Z' }, DRAFT_NOVEMBER],
    })
    mock.enqueue({ data: [] })
    const result = await upsert(['2026-10-19'])
    expect(result).toMatchObject({ ok: false, details: { settled: true, reason: 'late_day_needs_later_run' } })
  })

  it('names no later run when the company has none yet', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER] })
    mock.enqueue({ data: [] })
    const result = await upsert(['2026-10-19'])
    expect(result).toMatchObject({ ok: false, details: { later_salary_run: null } })
  })

  it('carries the late days to the next draft run with the employee on it', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: { id: 'sre-nov' } })
    mock.enqueue(OCTOBER_SLIP)
    mock.enqueue({ data: { salary_calculation_policy: {} } })
    const result = await upsert(['2026-10-19', '2026-10-20', '2026-11-02'], { carriedToRunId: 'run-nov' })
    expect(carriedTo(result)).toEqual({
      '2026-10-19': 'run-nov',
      '2026-10-20': 'run-nov',
      // November's own day is read by November's window: no carry.
      '2026-11-02': null,
    })
    expect(result.ok && result.plan.carriedReaderRunIds).toEqual(['run-nov'])
    expect(mock.findCalls('salary_run_employees', 'eq')).toEqual([
      ['company_id', COMPANY_ID],
      ['salary_run_id', 'run-nov'],
      ['employee_id', EMPLOYEE_ID],
      // The payslip of the run that read the days.
      ['company_id', COMPANY_ID],
      ['employee_id', EMPLOYEE_ID],
    ])
    expect(mock.findCalls('salary_run_employees', 'in')).toEqual([['salary_run_id', ['run-oct']]])
  })

  it('ignores the later run for days that are not late', async () => {
    mock.enqueue({ data: [DRAFT_NOVEMBER] })
    mock.enqueue({ data: [] })
    const result = await upsert(['2026-11-02'], { carriedToRunId: 'run-dec' })
    expect(carriedTo(result)).toEqual({ '2026-11-02': null })
    expect(fromCalls()).toEqual(['salary_runs', 'salary_absence_days'])
  })

  it("carries to a correction draft named for it while the period's AGI is not at Skatteverket", async () => {
    const runs = [
      BOOKED_OCTOBER,
      { ...DRAFT_NOVEMBER, status: 'corrected' },
      { ...DRAFT_NOVEMBER, id: 'run-nov-correction', corrects_run_id: 'run-nov' },
      DRAFT_DECEMBER,
    ]
    mock.enqueue({ data: runs })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: { status: 'generated' } }) // the period's declaration
    mock.enqueue({ data: [{ is_completed: false }] }) // its AGI deadline
    mock.enqueue({ data: { id: 'sre-nov-correction' } })
    mock.enqueue(OCTOBER_SLIP)
    mock.enqueue({ data: { salary_calculation_policy: {} } })
    const result = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov-correction' })
    expect(carriedTo(result)).toEqual({ '2026-10-19': 'run-nov-correction' })
    expect(mock.findCalls('agi_declarations', 'eq')).toEqual([
      ['company_id', COMPANY_ID],
      ['period_year', 2026],
      ['period_month', 11],
    ])
    expect(mock.findCalls('deadlines', 'eq')).toEqual([
      ['company_id', COMPANY_ID],
      ['tax_deadline_type', 'arbetsgivardeklaration'],
      ['tax_period', '2026-11'],
    ])

    // Never the default: unnamed, the days go to the next ordinary run.
    mock.enqueue({ data: runs })
    mock.enqueue({ data: [] })
    const unnamed = await upsert(['2026-10-19'])
    expect(unnamed).toMatchObject({ ok: false, details: { later_salary_run: { salary_run_id: 'run-dec' } } })
  })

  it.each([
    ['awaits signature', { data: { status: 'pending_signature' } }, { data: [] }],
    ['is filed', { data: { status: 'submitted' } }, { data: [] }],
    ['was filed outside the app (deadline done)', { data: null }, { data: [{ is_completed: true }] }],
  ])("refuses a correction draft whose period's AGI %s", async (_label, declaration, deadline) => {
    mock.enqueue({
      data: [
        BOOKED_OCTOBER,
        { ...DRAFT_NOVEMBER, status: 'corrected' },
        { ...DRAFT_NOVEMBER, id: 'run-nov-correction', corrects_run_id: 'run-nov' },
        DRAFT_DECEMBER,
      ],
    })
    mock.enqueue({ data: [] })
    mock.enqueue(declaration)
    mock.enqueue(deadline)
    const result = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov-correction' })
    expect(result).toMatchObject({
      ok: false,
      code: 'SALARY_REGISTER_LATE_DAY_REFUSED',
      details: { reason: 'correction_period_filed', later_salary_run: { salary_run_id: 'run-dec' } },
    })
  })

  it.each([
    ['not_found', [BOOKED_OCTOBER, DRAFT_NOVEMBER], 'run-missing'],
    ['not_draft', [BOOKED_OCTOBER, { ...DRAFT_NOVEMBER, status: 'review' }], 'run-nov'],
    ['not_later', [BOOKED_OCTOBER, DRAFT_SEPTEMBER], 'run-sep-draft'],
    ['not_next', [BOOKED_OCTOBER, DRAFT_NOVEMBER, DRAFT_DECEMBER], 'run-dec'],
  ] as const)('refuses a later run that cannot take the days: %s', async (reason, runs, target) => {
    mock.enqueue({ data: runs })
    mock.enqueue({ data: [] })
    const result = await upsert(['2026-10-19'], { carriedToRunId: target })
    expect(result).toMatchObject({
      ok: false,
      code: 'SALARY_REGISTER_LATE_DAY_REFUSED',
      details: { carried_to_run_id: target, reason, late_dates: ['2026-10-19'] },
    })
    if (reason === 'not_next') {
      expect(result).toMatchObject({
        details: { later_salary_run: { salary_run_id: 'run-nov', status: 'draft', period_year: 2026, period_month: 11 } },
      })
    }
  })

  it('a correction of a declared run takes no late day: its AGI is a rättelse, so the day goes to the next run', async () => {
    const runs = [
      BOOKED_OCTOBER,
      { ...DRAFT_NOVEMBER, status: 'corrected', agi_submitted_at: '2026-12-08T10:00:00Z' },
      { ...DRAFT_NOVEMBER, id: 'run-nov-correction', corrects_run_id: 'run-nov' },
      DRAFT_DECEMBER,
    ]
    const december = { salary_run_id: 'run-dec', status: 'draft', period_year: 2026, period_month: 12 }

    mock.enqueue({ data: runs })
    mock.enqueue({ data: [] })
    const unnamed = await upsert(['2026-10-19'])
    expect(unnamed).toMatchObject({
      ok: false,
      details: { salary_run_id: 'run-oct', reason: 'late_day_needs_later_run', later_salary_run: december },
    })

    // The receipt on the corrected run settles it without a query.
    mock.enqueue({ data: runs })
    mock.enqueue({ data: [] })
    const toCorrection = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov-correction' })
    expect(toCorrection).toMatchObject({
      ok: false,
      code: 'SALARY_REGISTER_LATE_DAY_REFUSED',
      details: { reason: 'correction_period_filed', later_salary_run: december },
    })
    expect(fromCalls()).not.toContain('agi_declarations')

    mock.enqueue({ data: runs })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: { id: 'sre-dec' } })
    mock.enqueue(OCTOBER_SLIP)
    mock.enqueue({ data: { salary_calculation_policy: {} } })
    const toDecember = await upsert(['2026-10-19'], { carriedToRunId: 'run-dec' })
    expect(carriedTo(toDecember)).toEqual({ '2026-10-19': 'run-dec' })
  })

  it('a correction chain is followed to the receipt on its first run', async () => {
    mock.enqueue({
      data: [
        BOOKED_OCTOBER,
        { ...DRAFT_NOVEMBER, status: 'corrected', agi_submitted_at: '2026-12-08T10:00:00Z' },
        { ...DRAFT_NOVEMBER, id: 'run-nov-c1', status: 'corrected', corrects_run_id: 'run-nov' },
        { ...DRAFT_NOVEMBER, id: 'run-nov-c2', corrects_run_id: 'run-nov-c1' },
        DRAFT_DECEMBER,
      ],
    })
    mock.enqueue({ data: [] })
    const result = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov-c2' })
    expect(result).toMatchObject({
      ok: false,
      details: { reason: 'correction_period_filed', later_salary_run: { salary_run_id: 'run-dec' } },
    })
  })

  it('a new day in the window of a declared run under correction is a late day of the next run', async () => {
    const runs = [
      { ...DRAFT_NOVEMBER, status: 'corrected', agi_submitted_at: '2026-12-08T10:00:00Z' },
      { ...DRAFT_NOVEMBER, id: 'run-nov-correction', corrects_run_id: 'run-nov' },
      DRAFT_DECEMBER,
    ]
    mock.enqueue({ data: runs })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ salary_run_id: 'run-nov' }] }) // November paid the employee
    const unnamed = await upsert(['2026-11-10'])
    expect(unnamed).toEqual({
      ok: false,
      code: 'SALARY_REGISTER_DATES_LOCKED_BY_RUN',
      details: {
        salary_run_id: 'run-nov',
        status: 'corrected',
        period_year: 2026,
        period_month: 11,
        deviation_period_start: '2026-11-01',
        deviation_period_end: '2026-11-30',
        locked_dates: ['2026-11-10'],
        settled: true,
        reason: 'late_day_needs_later_run',
        later_salary_run: { salary_run_id: 'run-dec', status: 'draft', period_year: 2026, period_month: 12 },
      },
    })
    expect(registerRefusalMessageSv('SALARY_REGISTER_DATES_LOCKED_BY_RUN', unnamed.ok ? undefined : unnamed.details, 'dashboard')).toContain(
      'lönekörning 2026-11 (rättad)',
    )

    mock.enqueue({ data: runs })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ salary_run_id: 'run-nov' }] })
    mock.enqueue({ data: { id: 'sre-dec' } })
    mock.enqueue({ data: [{ salary_run_id: 'run-nov', salary_type: 'monthly' }] })
    mock.enqueue({ data: { salary_calculation_policy: {} } })
    const toDecember = await upsert(['2026-11-10'], { carriedToRunId: 'run-dec' })
    expect(carriedTo(toDecember)).toEqual({ '2026-11-10': 'run-dec' })

    // A day already registered there stays the correction's to rework.
    mock.enqueue({ data: runs })
    mock.enqueue({ data: [{ absence_date: '2026-11-10', carried_to_run_id: null }] })
    const existing = await upsert(['2026-11-10'])
    expect(carriedTo(existing)).toEqual({ '2026-11-10': null })
  })

  it('a new day in the window of a corrected run not yet declared is late too: its pay went out', async () => {
    mock.enqueue({
      data: [
        { ...DRAFT_NOVEMBER, status: 'corrected' },
        { ...DRAFT_NOVEMBER, id: 'run-nov-correction', corrects_run_id: 'run-nov' },
        DRAFT_DECEMBER,
      ],
    })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ salary_run_id: 'run-nov' }] })
    const result = await upsert(['2026-11-10'])
    expect(result).toMatchObject({
      ok: false,
      details: { salary_run_id: 'run-nov', reason: 'late_day_needs_later_run', later_salary_run: { salary_run_id: 'run-dec' } },
    })

    // Named, its own correction does not come after the day.
    mock.enqueue({
      data: [
        { ...DRAFT_NOVEMBER, status: 'corrected' },
        { ...DRAFT_NOVEMBER, id: 'run-nov-correction', corrects_run_id: 'run-nov' },
        DRAFT_DECEMBER,
      ],
    })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ salary_run_id: 'run-nov' }] })
    const toCorrection = await upsert(['2026-11-10'], { carriedToRunId: 'run-nov-correction' })
    expect(toCorrection).toMatchObject({ ok: false, details: { reason: 'not_later' } })
  })

  it.each([
    ['booked', { ...DRAFT_NOVEMBER, status: 'booked' }],
    ['paid', { ...DRAFT_NOVEMBER, status: 'paid' }],
    ['declared', { ...DRAFT_NOVEMBER, status: 'approved', agi_submitted_at: '2026-12-08T10:00:00Z' }],
    ['corrected', { ...DRAFT_NOVEMBER, status: 'corrected' }],
  ] as const)('a named run that is %s answers not_next with the run that takes the days', async (_label, november) => {
    mock.enqueue({ data: [BOOKED_OCTOBER, november, DRAFT_DECEMBER] })
    mock.enqueue({ data: [] })
    const result = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov' })
    expect(result).toMatchObject({
      ok: false,
      code: 'SALARY_REGISTER_LATE_DAY_REFUSED',
      details: { reason: 'not_next', later_salary_run: { salary_run_id: 'run-dec' } },
    })
  })

  it.each(['vab', 'parental'])('refuses a late %s day of an hourly employee', async (absenceType) => {
    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: { id: 'sre-nov', salary_type: 'monthly', employee: { salary_type: 'hourly' } } })
    mock.enqueue({ data: [{ salary_run_id: 'run-oct', salary_type: 'hourly' }] })
    const result = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov', absenceType })
    expect(result).toMatchObject({ ok: false, code: 'SALARY_REGISTER_LATE_DAY_REFUSED', details: { reason: 'hourly_pay' } })
    expect(fromCalls()).not.toContain('company_settings')
    expect(mock.findCall('salary_run_employees', 'select')).toEqual(['id, salary_type, employee:employees(salary_type)'])
  })

  it("takes an hourly employee's late sick day and hours: sjuklön and timlön are owed", async () => {
    const hourlySlip = { data: { id: 'sre-nov', salary_type: 'hourly', employee: { salary_type: 'hourly' } } }
    const hourlyOctober = { data: [{ salary_run_id: 'run-oct', salary_type: 'hourly' }] }
    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue(hourlySlip)
    mock.enqueue(hourlyOctober)
    mock.enqueue({ data: { salary_calculation_policy: {} } })
    const sick = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov', absenceType: 'sick' })
    expect(carriedTo(sick)).toEqual({ '2026-10-19': 'run-nov' })

    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue(hourlySlip)
    mock.enqueue(hourlyOctober)
    const hours = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov', kind: 'worked' })
    expect(carriedTo(hours)).toEqual({ '2026-10-19': 'run-nov' })
  })

  it.each([
    ['monthly then, hourly now: sjuklön on top of a full salary', 'monthly', 'hourly', 'sick'],
    ['hourly then, monthly now: a deduction from hours never paid', 'hourly', 'monthly', 'vab'],
    ['monthly then, hourly now: hours the salary already paid', 'monthly', 'hourly', undefined],
  ] as const)('refuses a late day priced under another pay type than its period paid (%s)', async (_label, then, now, type) => {
    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: { id: 'sre-nov', salary_type: now, employee: { salary_type: now } } })
    mock.enqueue({ data: [{ salary_run_id: 'run-oct', salary_type: then }] })
    const result = await upsert(
      ['2026-10-19'],
      type ? { carriedToRunId: 'run-nov', absenceType: type } : { carriedToRunId: 'run-nov', kind: 'worked' },
    )
    expect(result).toMatchObject({
      ok: false,
      code: 'SALARY_REGISTER_LATE_DAY_REFUSED',
      details: {
        reason: 'pay_type_changed',
        period_salary_run: { salary_run_id: 'run-oct', status: 'booked', period_year: 2026, period_month: 10 },
      },
    })
  })

  it('refuses late absence from a period that paid the employee nothing, and takes the hours worked then', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: { id: 'sre-nov' } })
    mock.enqueue({ data: [] })
    const absent = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov' })
    expect(absent).toMatchObject({ ok: false, details: { reason: 'not_paid_then', period_salary_run: { salary_run_id: 'run-oct' } } })

    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: { id: 'sre-nov' } })
    mock.enqueue({ data: [] })
    const hours = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov', kind: 'worked' })
    expect(carriedTo(hours)).toEqual({ '2026-10-19': 'run-nov' })
  })

  it('surfaces a failed read of the period payslips as INTERNAL_ERROR', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: { id: 'sre-nov' } })
    mock.enqueue({ data: null, error: { message: 'boom' } })
    const result = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov' })
    expect(result).toEqual({ ok: false, code: 'INTERNAL_ERROR', details: { message: 'boom' } })
  })

  it('a booked November does not hold the day back: it goes to the first run not yet paid', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER, { ...DRAFT_NOVEMBER, status: 'booked' }, DRAFT_DECEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: { id: 'sre-dec' } })
    mock.enqueue(OCTOBER_SLIP)
    mock.enqueue({ data: { salary_calculation_policy: {} } })
    const result = await upsert(['2026-10-19'], { carriedToRunId: 'run-dec' })
    expect(carriedTo(result)).toEqual({ '2026-10-19': 'run-dec' })
  })

  it('refuses a later run without the employee on it', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: null })
    const result = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov' })
    expect(result).toMatchObject({ ok: false, details: { reason: 'employee_not_on_run' } })
  })

  it('refuses a late parental day when the company prices long leave per calendar day', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: { id: 'sre-nov' } })
    mock.enqueue(OCTOBER_SLIP)
    mock.enqueue({ data: { salary_calculation_policy: { long_leave: 'calendar_after_five_workdays' } } })
    const result = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov' })
    expect(result).toMatchObject({ ok: false, details: { reason: 'calendar_long_leave' } })
  })

  it('a late VAB day and late worked hours never read the calculation policy', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: { id: 'sre-nov' } })
    mock.enqueue(OCTOBER_SLIP)
    const vab = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov', absenceType: 'vab' })
    expect(vab.ok).toBe(true)

    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: { id: 'sre-nov' } })
    mock.enqueue(OCTOBER_SLIP)
    const worked = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov', kind: 'worked' })
    expect(worked.ok).toBe(true)
    expect(fromCalls()).not.toContain('company_settings')
    expect(mock.findCall('salary_worked_days', 'select')).toEqual(['work_date, carried_to_run_id'])
  })
})

describe('planRegisterUpsert: days already registered', () => {
  it('does not rewrite a day a booked run read, even with a later run named', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER] })
    mock.enqueue({ data: [{ absence_date: '2026-10-19', carried_to_run_id: null }] })
    const result = await upsert(['2026-10-19'], { carriedToRunId: 'run-nov' })
    expect(result).toMatchObject({
      ok: false,
      code: 'SALARY_REGISTER_DATES_LOCKED_BY_RUN',
      details: { salary_run_id: 'run-oct', reason: 'read_by_settled_run', settled: true },
    })
  })

  it('keeps the carry of a late day already carried to a draft, whatever window holds its date', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER] })
    mock.enqueue({ data: [{ absence_date: '2026-10-19', carried_to_run_id: 'run-nov' }] })
    const result = await upsert(['2026-10-19'])
    expect(carriedTo(result)).toEqual({ '2026-10-19': 'run-nov' })
    expect(result.ok && result.plan.carriedReaderRunIds).toEqual(['run-nov'])
  })

  it('locks a late day once the run it is carried to is past draft', async () => {
    mock.enqueue({ data: [BOOKED_OCTOBER, { ...DRAFT_NOVEMBER, status: 'review' }] })
    mock.enqueue({ data: [{ absence_date: '2026-10-19', carried_to_run_id: 'run-nov' }] })
    const review = await upsert(['2026-10-19'])
    expect(review).toMatchObject({ ok: false, details: { salary_run_id: 'run-nov', reason: 'run_not_settled' } })

    mock.enqueue({ data: [BOOKED_OCTOBER, { ...DRAFT_NOVEMBER, status: 'booked' }] })
    mock.enqueue({ data: [{ absence_date: '2026-10-19', carried_to_run_id: 'run-nov' }] })
    const booked = await upsert(['2026-10-19'])
    expect(booked).toMatchObject({ ok: false, details: { salary_run_id: 'run-nov', reason: 'read_by_settled_run' } })
  })

  it('a late day carried to a corrected run is read by its correction', async () => {
    mock.enqueue({
      data: [
        BOOKED_OCTOBER,
        { ...DRAFT_NOVEMBER, status: 'corrected' },
        { ...DRAFT_NOVEMBER, id: 'run-nov-correction', corrects_run_id: 'run-nov' },
      ],
    })
    mock.enqueue({ data: [{ absence_date: '2026-10-19', carried_to_run_id: 'run-nov' }] })
    const result = await upsert(['2026-10-19'])
    expect(carriedTo(result)).toEqual({ '2026-10-19': 'run-nov' })
    expect(result.ok && result.plan.carriedReaderRunIds).toEqual(['run-nov-correction'])
  })
})

describe('checkRegisterRangeDelete', () => {
  function del(from: string, to: string, kind: 'absence' | 'worked' = 'absence') {
    return checkRegisterRangeDelete(supabase, COMPANY_ID, { kind, employeeId: EMPLOYEE_ID, from, to })
  }

  it('a range with nothing registered deletes nothing and reads no runs', async () => {
    mock.enqueue({ data: [] })
    expect(await del('2026-10-01', '2026-10-31')).toEqual({ ok: true, carriedReaderRunIds: [] })
    expect(fromCalls()).toEqual(['salary_absence_days'])
  })

  it('refuses rows a booked run read, naming their dates', async () => {
    mock.enqueue({
      data: [
        { absence_date: '2026-10-05', carried_to_run_id: null },
        { absence_date: '2026-10-06', carried_to_run_id: null },
      ],
    })
    mock.enqueue({ data: [BOOKED_OCTOBER] })
    const result = await del('2026-10-01', '2026-10-31')
    expect(result).toMatchObject({
      ok: false,
      code: 'SALARY_REGISTER_DATES_LOCKED_BY_RUN',
      details: { salary_run_id: 'run-oct', locked_dates: ['2026-10-05', '2026-10-06'], reason: 'read_by_settled_run' },
    })
  })

  it('deletes a late day carried to a draft, inside a booked window', async () => {
    mock.enqueue({ data: [{ work_date: '2026-10-19', carried_to_run_id: 'run-nov' }] })
    mock.enqueue({ data: [BOOKED_OCTOBER, DRAFT_NOVEMBER] })
    expect(await del('2026-10-19', '2026-10-19', 'worked')).toEqual({ ok: true, carriedReaderRunIds: ['run-nov'] })
  })

  it('refuses a late day whose run is booked', async () => {
    mock.enqueue({ data: [{ absence_date: '2026-10-19', carried_to_run_id: 'run-nov' }] })
    mock.enqueue({ data: [BOOKED_OCTOBER, { ...DRAFT_NOVEMBER, status: 'booked' }] })
    const result = await del('2026-10-19', '2026-10-19')
    expect(result).toMatchObject({ ok: false, details: { salary_run_id: 'run-nov', reason: 'read_by_settled_run' } })
  })

  it('passes a lookup failure through as INTERNAL_ERROR', async () => {
    mock.enqueue({ data: null, error: { message: 'boom' } })
    expect(await del('2026-10-01', '2026-10-31')).toEqual({ ok: false, code: 'INTERNAL_ERROR', details: { message: 'boom' } })
  })
})

describe('registerRefusalMessageSv', () => {
  const lateLock = {
    salary_run_id: 'run-oct',
    status: 'booked',
    period_year: 2026,
    period_month: 10,
    deviation_period_start: '2026-10-01',
    deviation_period_end: '2026-10-31',
    locked_dates: ['2026-10-19', '2026-10-30'],
    settled: true,
    reason: 'late_day_needs_later_run',
    later_salary_run: { salary_run_id: 'run-nov', status: 'draft', period_year: 2026, period_month: 11 },
  }

  it('tells the dashboard to register a late day from the next run, an API caller to name it', () => {
    const dashboard = registerRefusalMessageSv('SALARY_REGISTER_DATES_LOCKED_BY_RUN', lateLock, 'dashboard')
    expect(dashboard).toContain('2026-10-19 till 2026-10-30')
    expect(dashboard).toContain('2026-10 (bokförd)')
    expect(dashboard).toContain('2026-11 (utkast)')
    expect(dashboard).toContain('kalendern på lönebeskedet')
    expect(dashboard).not.toContain('run-nov')

    const api = registerRefusalMessageSv('SALARY_REGISTER_DATES_LOCKED_BY_RUN', lateLock, 'api')
    expect(api).toContain('carried_to_run_id')
    expect(api).toContain('run-nov')
    expect(api).not.toMatch(/rättelse/)
  })

  it('words a run to revert and a day already paid', () => {
    expect(
      registerRefusalMessageSv(
        'SALARY_REGISTER_DATES_LOCKED_BY_RUN',
        { ...lateLock, status: 'review', reason: 'run_not_settled' },
        'dashboard',
      ),
    ).toContain('Återställ den till utkast')
    expect(
      registerRefusalMessageSv('SALARY_REGISTER_DATES_LOCKED_BY_RUN', { ...lateLock, reason: 'read_by_settled_run' }, 'dashboard'),
    ).toContain('egen rad på nästa lönebesked')
  })

  it('words every refused later run', () => {
    for (const reason of [
      'not_found',
      'not_draft',
      'not_later',
      'not_next',
      'correction_period_filed',
      'employee_not_on_run',
      'calendar_long_leave',
      'hourly_pay',
      'pay_type_changed',
      'not_paid_then',
    ]) {
      const text = registerRefusalMessageSv(
        'SALARY_REGISTER_LATE_DAY_REFUSED',
        { carried_to_run_id: 'run-x', reason, late_dates: ['2026-10-19'], salary_run: lateLock.later_salary_run },
        'dashboard',
      )
      expect(text, reason).toBeTruthy()
    }
  })

  it('says why an hourly employee\'s late VAB or parental day has no later run', () => {
    const text = registerRefusalMessageSv(
      'SALARY_REGISTER_LATE_DAY_REFUSED',
      { carried_to_run_id: 'run-x', reason: 'hourly_pay', late_dates: ['2026-10-19', '2026-10-20'] },
      'api',
    )
    expect(text).toBe(
      'Den anställde har timlön, så VAB och föräldraledighet 2026-10-19 till 2026-10-20 drar inget från lönen i en senare körning. ' +
        'Frånvaron påverkade lönen i perioden då den var, och frånvarouppgiften hör inte till en senare arbetsgivardeklaration.',
    )
  })

  it('names the run that takes the days instead of a correction of a filed period', () => {
    const text = registerRefusalMessageSv(
      'SALARY_REGISTER_LATE_DAY_REFUSED',
      {
        carried_to_run_id: 'run-nov-correction',
        reason: 'correction_period_filed',
        late_dates: ['2026-10-19'],
        salary_run: { salary_run_id: 'run-nov-correction', status: 'draft', period_year: 2026, period_month: 11 },
        later_salary_run: { salary_run_id: 'run-dec', status: 'draft', period_year: 2026, period_month: 12 },
      },
      'dashboard',
    )
    expect(text).toBe(
      'Lönekörning 2026-11 (utkast) rättar en period vars arbetsgivardeklaration redan finns hos Skatteverket, och en rättelse kan inte ta emot nya frånvarouppgifter. ' +
        'Dagarna 2026-10-19 dras i lönekörning 2026-12 (utkast).',
    )
  })

  it('names the period whose pay type or payslip stops a late day', () => {
    const october = { salary_run_id: 'run-oct', status: 'booked', period_year: 2026, period_month: 10 }
    const november = { salary_run_id: 'run-nov', status: 'draft', period_year: 2026, period_month: 11 }
    const base = { carried_to_run_id: 'run-nov', late_dates: ['2026-10-19'], salary_run: november, period_salary_run: october }
    expect(registerRefusalMessageSv('SALARY_REGISTER_LATE_DAY_REFUSED', { ...base, reason: 'pay_type_changed' }, 'dashboard')).toBe(
      'Den anställde hade en annan lönetyp (månadslön eller timlön) i lönekörning 2026-10 (bokförd) än på lönekörning 2026-11 (utkast). ' +
        'Dagarna 2026-10-19 kan då inte räknas om i en senare körning: lägg in skillnaden som en egen rad på lönebeskedet.',
    )
    expect(registerRefusalMessageSv('SALARY_REGISTER_LATE_DAY_REFUSED', { ...base, reason: 'not_paid_then' }, 'dashboard')).toBe(
      'Den anställde fick ingen lön i lönekörning 2026-10 (bokförd), så det finns inget utbetalt för dagarna 2026-10-19 att dra av i efterhand.',
    )
  })

  it('is null for any other code', () => {
    expect(registerRefusalMessageSv('VALIDATION_ERROR', { field: 'x' }, 'api')).toBeNull()
    expect(registerRefusalMessageSv('SALARY_REGISTER_DATES_LOCKED_BY_RUN', undefined, 'api')).toBeNull()
  })
})
