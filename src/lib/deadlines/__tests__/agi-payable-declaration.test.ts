/**
 * Whether a stored AGI declaration's totals may be paid
 * (../agi-payable-declaration.ts, crm#1768): the generator's check for other
 * live runs paid out in the month, asked of a declaration already stored.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { readAgiPaymentPeriodConflict } from '../agi-payable-declaration'

const COMPANY = 'company-1'
type Chain = Array<{ method: string; args: unknown[] }>

const OWN_RUN = { id: 'run-own', corrects_run_id: null }
const OWN_LIVE = {
  id: 'run-own',
  status: 'booked',
  period_year: 2026,
  period_month: 11,
  payment_date: '2026-11-25',
  corrects_run_id: null,
}
const OTHER_LIVE = {
  id: 'run-other',
  status: 'approved',
  period_year: 2026,
  period_month: 10,
  payment_date: '2026-11-05',
  corrects_run_id: null,
}

/** salary_runs: the declaration's own run by id, and the live runs of the month. */
function salaryRuns(own: Record<string, unknown> | null, live: Array<Record<string, unknown>>, errors: { own?: unknown; live?: unknown } = {}) {
  return (calls: Chain) => {
    const select = calls.find((c) => c.method === 'select')?.args[0]
    if (select === 'id, corrects_run_id') return errors.own ? { data: null, error: errors.own } : { data: own }
    return errors.live ? { data: null, error: errors.live } : { data: live }
  }
}

const UNFILED = { salary_run_id: 'run-own', status: 'generated', period_year: 2026, period_month: 11 }

let db: ReturnType<typeof createTableMockSupabase>

beforeEach(() => {
  db = createTableMockSupabase({ salary_runs: salaryRuns(OWN_RUN, [OWN_LIVE]) })
})

describe('readAgiPaymentPeriodConflict', () => {
  it('lets a single-run month be paid, asking the same query as the generator', async () => {
    expect(await readAgiPaymentPeriodConflict(db.supabase as never, COMPANY, UNFILED)).toEqual({ ok: true, conflict: null })

    expect(db.findCalls('salary_runs', 'eq')).toEqual([
      ['id', 'run-own'],
      ['company_id', COMPANY],
      ['company_id', COMPANY],
    ])
    expect(db.findCall('salary_runs', 'in')).toEqual(['status', ['review', 'approved', 'paid', 'booked']])
    expect(db.findCall('salary_runs', 'gte')).toEqual(['payment_date', '2026-11-01'])
    expect(db.findCall('salary_runs', 'lte')).toEqual(['payment_date', '2026-11-30'])
  })

  it('refuses an unfiled declaration while another live run is paid out in its month, naming that run', async () => {
    db.setTable('salary_runs', salaryRuns(OWN_RUN, [OWN_LIVE, OTHER_LIVE]))

    const result = await readAgiPaymentPeriodConflict(db.supabase as never, COMPANY, UNFILED)

    if (!result.ok || !result.conflict) throw new Error('expected a refusal')
    expect(result.conflict).toMatchObject({
      code: 'AGI_PAYMENT_PERIOD_CONFLICT',
      details: {
        period: '2026-11',
        other_salary_run_id: 'run-other',
        other_run_period: '2026-10',
        other_runs: [{ salary_run_id: 'run-other', run_period: '2026-10', payment_date: '2026-11-05', status: 'approved' }],
      },
    })
    expect(result.conflict.messageSv).toBe(
      'Lönekörningen för 2026-10 med utbetalning 2026-11-05 hör också till redovisningsperiod 2026-11. ' +
        'Arbetsgivardeklarationen som Accounted har för 2026-11 räknar bara med en av körningarna, så dess belopp betalas inte från Accounted. ' +
        'Lämna in deklarationen för 2026-11 med summan av körningarna i Skatteverkets e-tjänst och betala det belopp den ger.',
    )
    expect(result.conflict.details.message).toBe(result.conflict.messageSv)
    expect(result.conflict.messageEn).toBe(
      'The salary run for 2026-10 paid out 2026-11-05 also belongs to reporting period 2026-11. ' +
        'The employer declaration Accounted holds for 2026-11 covers only one of the runs, so its amount is not paid from Accounted. ' +
        "File the declaration for 2026-11 with the sum of the runs in Skatteverket's e-service and pay the amount it gives.",
    )
  })

  it('names every other run', async () => {
    const third = { ...OTHER_LIVE, id: 'run-third', period_year: 2026, period_month: 9, payment_date: '2026-11-02' }
    db.setTable('salary_runs', salaryRuns(OWN_RUN, [OWN_LIVE, OTHER_LIVE, third]))

    const result = await readAgiPaymentPeriodConflict(db.supabase as never, COMPANY, UNFILED)

    if (!result.ok || !result.conflict) throw new Error('expected a refusal')
    expect(result.conflict.details.other_runs.map((r) => r.salary_run_id)).toEqual(['run-third', 'run-other'])
    expect(result.conflict.messageSv).toMatch(
      /^Lönekörningarna för 2026-09 med utbetalning 2026-11-02 och 2026-10 med utbetalning 2026-11-05 hör också till/,
    )
    expect(result.conflict.messageEn).toMatch(
      /^The salary runs for 2026-09 paid out 2026-11-02 and 2026-10 paid out 2026-11-05 also belong to/,
    )
  })

  it('leaves a filed declaration alone without reading a run', async () => {
    db.setTable('salary_runs', salaryRuns(OWN_RUN, [OWN_LIVE, OTHER_LIVE]))
    for (const status of ['submitted', 'accepted']) {
      expect(await readAgiPaymentPeriodConflict(db.supabase as never, COMPANY, { ...UNFILED, status })).toEqual({
        ok: true,
        conflict: null,
      })
    }
    expect(db.findCall('salary_runs', 'select')).toBeUndefined()
  })

  it('does not count the run the declaration corrects, or a correction of it', async () => {
    const correction = { ...OTHER_LIVE, id: 'run-correction', corrects_run_id: 'run-own' }
    db.setTable('salary_runs', salaryRuns(OWN_RUN, [OWN_LIVE, correction]))
    expect(await readAgiPaymentPeriodConflict(db.supabase as never, COMPANY, UNFILED)).toEqual({ ok: true, conflict: null })

    const original = { ...OTHER_LIVE, id: 'run-original' }
    db.setTable('salary_runs', salaryRuns({ id: 'run-own', corrects_run_id: 'run-original' }, [OWN_LIVE, original]))
    expect(await readAgiPaymentPeriodConflict(db.supabase as never, COMPANY, UNFILED)).toEqual({ ok: true, conflict: null })
  })

  it('refuses a declaration whose run is gone while a live run is paid out in its month', async () => {
    db.setTable('salary_runs', salaryRuns(null, [OTHER_LIVE]))
    const result = await readAgiPaymentPeriodConflict(db.supabase as never, COMPANY, { ...UNFILED, salary_run_id: null })
    expect(result).toMatchObject({ ok: true, conflict: { details: { other_salary_run_id: 'run-other' } } })
    // No run to read: only the month's live runs.
    expect(db.findCalls('salary_runs', 'select')).toEqual([['id, status, period_year, period_month, payment_date, corrects_run_id']])
  })

  it('answers ok false when the run or the month cannot be read, so the caller refuses', async () => {
    db.setTable('salary_runs', salaryRuns(OWN_RUN, [OWN_LIVE], { own: { message: 'boom' } }))
    expect(await readAgiPaymentPeriodConflict(db.supabase as never, COMPANY, UNFILED)).toEqual({ ok: false, error: { message: 'boom' } })

    db.setTable('salary_runs', salaryRuns(OWN_RUN, [OWN_LIVE], { live: { message: 'boom' } }))
    expect(await readAgiPaymentPeriodConflict(db.supabase as never, COMPANY, UNFILED)).toEqual({ ok: false, error: { message: 'boom' } })
  })
})
