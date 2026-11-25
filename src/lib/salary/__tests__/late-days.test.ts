/**
 * Unit tests for lib/salary/late-days.ts, the reading rule for late days, and
 * for lateAbsenceRefusal in derive-absence-line-items.ts, which names the
 * late days the engine cannot price as a run's own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  correctionPeriodFiled,
  describeLateDates,
  lateDayReaderRunIds,
  lateDaysCarriedTo,
  lateDaysSuffix,
  registerRowReadByRun,
  runIsSettled,
  runOfPayslip,
} from '@/lib/salary/late-days'
import { lateAbsenceRefusal, type EmployeeAbsenceRows } from '@/lib/salary/derive-absence-line-items'

const COMPANY_ID = 'company-1'

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
})

describe('runIsSettled', () => {
  it('is paid, booked (corrected since included) or declared', () => {
    expect(runIsSettled({ status: 'paid' })).toBe(true)
    expect(runIsSettled({ status: 'booked' })).toBe(true)
    expect(runIsSettled({ status: 'corrected' })).toBe(true)
    expect(runIsSettled({ status: 'approved', agi_submitted_at: '2026-11-09T16:33:59Z' })).toBe(true)
    expect(runIsSettled({ status: 'approved', agi_submitted_at: null })).toBe(false)
    expect(runIsSettled({ status: 'review' })).toBe(false)
    expect(runIsSettled({ status: 'draft' })).toBe(false)
  })
})

describe('correctionPeriodFiled', () => {
  const filed = '2026-12-08T10:00:00Z'
  const period = { period_year: 2026, period_month: 11, payment_date: '2026-11-25' }

  it('answers from a receipt anywhere in the chain it corrects, without a query', async () => {
    const original = { id: 'r1', agi_submitted_at: filed, corrects_run_id: null, ...period }
    const first = { id: 'r2', agi_submitted_at: null, corrects_run_id: 'r1', ...period }
    const second = { id: 'r3', agi_submitted_at: null, corrects_run_id: 'r2', ...period }
    expect(await correctionPeriodFiled(supabase, COMPANY_ID, second, [original, first, second])).toEqual({ ok: true, filed: true })
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it("reads the declaration and the AGI deadline of the period it declares (the payout month)", async () => {
    const correction = { id: 'r2', corrects_run_id: 'r1', period_year: 2026, period_month: 10, payment_date: '2026-11-25' }
    mock.enqueue({ data: { status: 'generated' } })
    mock.enqueue({ data: [{ is_completed: false }] })
    expect(await correctionPeriodFiled(supabase, COMPANY_ID, correction, [{ id: 'r1' }, correction])).toEqual({ ok: true, filed: false })
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
    expect(mock.findCall('deadlines', 'is')).toEqual(['dismissed_at', null])
  })

  it.each([
    ['pending_signature', [], true],
    ['submitted', [], true],
    ['accepted', [], true],
    ['exported', [], false],
    [null, [{ is_completed: true }], true],
    [null, [], false],
  ] as const)('a declaration in %s with deadline rows %j is filed: %s', async (status, deadlines, expected) => {
    mock.enqueue({ data: status ? { status } : null })
    mock.enqueue({ data: deadlines })
    const correction = { id: 'r2', corrects_run_id: 'r1', ...period }
    expect(await correctionPeriodFiled(supabase, COMPANY_ID, correction, [correction])).toEqual({ ok: true, filed: expected })
  })

  it('reports a failed read, and ends on a chain that loops', async () => {
    mock.enqueue({ data: null, error: { message: 'boom' } })
    mock.enqueue({ data: [] })
    const a = { id: 'a', corrects_run_id: 'b', ...period }
    const b = { id: 'b', corrects_run_id: 'a', ...period }
    expect(await correctionPeriodFiled(supabase, COMPANY_ID, a, [a, b])).toEqual({ ok: false, message: 'boom' })
  })
})

describe('lateDaysCarriedTo', () => {
  it('reads both registers for the runs, company and employee scoped, and merges the dates', async () => {
    mock.enqueue({ data: [{ absence_date: '2026-10-20' }, { absence_date: '2026-10-19' }] })
    mock.enqueue({ data: [{ work_date: '2026-10-19' }] })
    const result = await lateDaysCarriedTo(supabase, COMPANY_ID, 'emp-1', ['run-nov', 'run-nov-original'])
    expect(result).toEqual({ ok: true, dates: ['2026-10-19', '2026-10-20'] })
    for (const table of ['salary_absence_days', 'salary_worked_days']) {
      expect(mock.findCalls(table, 'eq')).toEqual([
        ['company_id', COMPANY_ID],
        ['employee_id', 'emp-1'],
      ])
      expect(mock.findCall(table, 'in')).toEqual(['carried_to_run_id', ['run-nov', 'run-nov-original']])
    }
  })

  it('asks nothing without runs, and reports a failed read', async () => {
    expect(await lateDaysCarriedTo(supabase, COMPANY_ID, 'emp-1', [])).toEqual({ ok: true, dates: [] })
    expect(mock.supabase.from).not.toHaveBeenCalled()

    mock.enqueue({ data: [] })
    mock.enqueue({ data: null, error: { message: 'boom' } })
    expect(await lateDaysCarriedTo(supabase, COMPANY_ID, 'emp-1', ['run-nov'])).toEqual({ ok: false, message: 'boom' })
  })
})

describe('registerRowReadByRun', () => {
  it('a carried row belongs only to the run it is carried to, any other to its window', () => {
    expect(registerRowReadByRun({ carried_to_run_id: 'run-nov' }, ['run-nov'], false)).toBe(true)
    expect(registerRowReadByRun({ carried_to_run_id: 'run-nov' }, ['run-oct'], true)).toBe(false)
    expect(registerRowReadByRun({ carried_to_run_id: null }, ['run-oct'], true)).toBe(true)
    expect(registerRowReadByRun({}, ['run-oct'], false)).toBe(false)
  })
})

describe('lateDayReaderRunIds', () => {
  it('an ordinary run reads its own late days, without a query', async () => {
    expect(await lateDayReaderRunIds(supabase, COMPANY_ID, { id: 'run-1', corrects_run_id: null })).toEqual(['run-1'])
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('a correction run reads the late days of every run it corrects, nearest first', async () => {
    mock.enqueue({ data: { id: 'run-b', corrects_run_id: 'run-a' } })
    mock.enqueue({ data: { id: 'run-a', corrects_run_id: null } })
    const ids = await lateDayReaderRunIds(supabase, COMPANY_ID, { id: 'run-c', corrects_run_id: 'run-b' })
    expect(ids).toEqual(['run-c', 'run-b', 'run-a'])
    expect(mock.findCalls('salary_runs', 'eq')).toEqual([
      ['id', 'run-b'],
      ['company_id', COMPANY_ID],
      ['id', 'run-a'],
      ['company_id', COMPANY_ID],
    ])
  })

  it('throws on a chain that loops or a corrected run it cannot read', async () => {
    mock.enqueue({ data: { id: 'run-b', corrects_run_id: 'run-c' } })
    await expect(lateDayReaderRunIds(supabase, COMPANY_ID, { id: 'run-c', corrects_run_id: 'run-b' })).rejects.toThrow(
      /does not end/,
    )
    mock.enqueue({ data: null })
    await expect(lateDayReaderRunIds(supabase, COMPANY_ID, { id: 'run-c', corrects_run_id: 'run-x' })).rejects.toThrow(
      /not found/,
    )
  })
})

describe('runOfPayslip', () => {
  it("answers the payslip's run, and null without one or when it cannot be read", async () => {
    expect(await runOfPayslip(supabase, COMPANY_ID, null)).toBeNull()
    expect(mock.supabase.from).not.toHaveBeenCalled()

    mock.enqueue({ data: { salary_run_id: 'run-nov' } })
    expect(await runOfPayslip(supabase, COMPANY_ID, 'sre-1')).toBe('run-nov')
    expect(mock.findCalls('salary_run_employees', 'eq')).toEqual([
      ['id', 'sre-1'],
      ['company_id', COMPANY_ID],
    ])

    mock.enqueue({ data: null, error: { message: 'boom' } })
    expect(await runOfPayslip(supabase, COMPANY_ID, 'sre-1')).toBeNull()
  })

  it("answers null for a correction's payslip: a click in its calendar does not name the correction", async () => {
    mock.enqueue({ data: { salary_run_id: 'run-nov-correction', salary_run: { corrects_run_id: 'run-nov' } } })
    expect(await runOfPayslip(supabase, COMPANY_ID, 'sre-1')).toBeNull()
    mock.enqueue({ data: { salary_run_id: 'run-dec', salary_run: { corrects_run_id: null } } })
    expect(await runOfPayslip(supabase, COMPANY_ID, 'sre-2')).toBe('run-dec')
    expect(mock.findCall('salary_run_employees', 'select')).toEqual(['salary_run_id, salary_run:salary_runs(corrects_run_id)'])
  })
})

describe('describeLateDates / lateDaysSuffix', () => {
  it('joins consecutive days, across weekends and public holidays, and lists the rest', () => {
    expect(describeLateDates(['2026-10-12', '2026-10-13'])).toBe('2026-10-12 till 2026-10-13')
    // Friday to Monday: the weekend does not break the span.
    expect(describeLateDates(['2026-10-16', '2026-10-19'])).toBe('2026-10-16 till 2026-10-19')
    // A working day between: two spans.
    expect(describeLateDates(['2026-10-05', '2026-10-07'])).toBe('2026-10-05, 2026-10-07')
    // Christmas Eve to the 28th: Christmas Day, Boxing Day and the weekend are no working days.
    expect(describeLateDates(['2026-12-23', '2026-12-28'])).toBe('2026-12-23 till 2026-12-28')
    expect(describeLateDates(['2026-10-07', '2026-10-05', '2026-10-05'])).toBe('2026-10-05, 2026-10-07')
  })

  it('says varav when the line also holds days of its own period', () => {
    expect(lateDaysSuffix(['2026-10-29', '2026-10-30'], true)).toBe(', från tidigare period: 2026-10-29 till 2026-10-30')
    expect(lateDaysSuffix(['2026-10-30'], false)).toBe(', varav från tidigare period: 2026-10-30')
    expect(lateDaysSuffix([], true)).toBe('')
  })
})

describe('lateAbsenceRefusal', () => {
  const rows = (fields: Partial<EmployeeAbsenceRows>): EmployeeAbsenceRows => ({
    periodDays: [],
    lateDays: [],
    contextDays: [],
    lookbackSickDays: [],
    vabDaysYtd: 0,
    parentalDaysPregnancyYtd: 0,
    ...fields,
  })
  const sick = (absence_date: string) => ({ absence_date, absence_type: 'sick' as const, hours: 8 })
  const parental = (absence_date: string) => ({ absence_date, absence_type: 'parental' as const, hours: 8 })

  it('has nothing to say without late days', () => {
    expect(lateAbsenceRefusal(rows({ periodDays: [sick('2026-11-02')] }), { calendarLongLeave: true })).toBeNull()
  })

  it('refuses late long leave under the calendar convention, but not late VAB', () => {
    const late = [parental('2026-10-29'), parental('2026-10-30')]
    expect(lateAbsenceRefusal(rows({ periodDays: late, lateDays: late }), { calendarLongLeave: true })).toContain(
      '2026-10-29 till 2026-10-30',
    )
    expect(lateAbsenceRefusal(rows({ periodDays: late, lateDays: late }), { calendarLongLeave: false })).toBeNull()
    const vab = [{ absence_date: '2026-10-30', absence_type: 'vab' as const, hours: 8 }]
    expect(lateAbsenceRefusal(rows({ periodDays: vab, lateDays: vab }), { calendarLongLeave: true })).toBeNull()
  })

  it('lets a late sick day continue a sjuklöneperiod an earlier run priced', () => {
    const late = [sick('2026-10-15')]
    expect(
      lateAbsenceRefusal(
        rows({ periodDays: late, lateDays: late, lookbackSickDays: [sick('2026-10-13'), sick('2026-10-14')] }),
        { calendarLongLeave: false },
      ),
    ).toBeNull()
  })

  it('refuses a late sick day before a sick day an earlier run priced in the same period', () => {
    const late = [sick('2026-10-13')]
    const refusal = lateAbsenceRefusal(
      rows({ periodDays: late, lateDays: late, lookbackSickDays: [sick('2026-10-14'), sick('2026-10-15')] }),
      { calendarLongLeave: false },
    )
    expect(refusal).toContain('Sjukdagen 2026-10-13')
    expect(refusal).toContain('2026-10-14')
  })

  it('refuses a late VAB or parental day the run deducts nothing for, and nothing else', () => {
    const vab = { absence_date: '2026-10-20', absence_type: 'vab' as const, hours: 8 }
    const late = [vab, parental('2026-10-21'), sick('2026-10-22')]
    const hourly = lateAbsenceRefusal(rows({ periodDays: late, lateDays: late }), {
      calendarLongLeave: false,
      noDeduction: 'hourly',
    })
    expect(hourly).toContain('2026-10-20 till 2026-10-21')
    expect(hourly).toContain('den anställde har timlön')
    expect(
      lateAbsenceRefusal(rows({ periodDays: [vab], lateDays: [vab] }), { calendarLongLeave: false, noDeduction: 'no_salary' }),
    ).toContain('månadslönen är 0 kr')
    // A late sick day is owed sjuklön even under hourly pay; timely days are no concern here.
    expect(
      lateAbsenceRefusal(rows({ periodDays: [sick('2026-10-22')], lateDays: [sick('2026-10-22')] }), {
        calendarLongLeave: false,
        noDeduction: 'hourly',
      }),
    ).toBeNull()
    expect(
      lateAbsenceRefusal(rows({ periodDays: [vab] }), { calendarLongLeave: false, noDeduction: 'hourly' }),
    ).toBeNull()
  })

  it('a late sick day in a period of its own, well before the priced days, is priced normally', () => {
    const late = [sick('2026-10-01')]
    expect(
      lateAbsenceRefusal(rows({ periodDays: late, lateDays: late, lookbackSickDays: [sick('2026-10-20')] }), {
        calendarLongLeave: false,
      }),
    ).toBeNull()
  })
})
