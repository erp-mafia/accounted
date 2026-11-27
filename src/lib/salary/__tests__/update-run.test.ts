/**
 * updateDraftSalaryRun (lib/salary/update-run.ts): the one draft-header edit
 * behind the dashboard PATCH, the v1 PATCH and the MCP update tool.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { invalidateRunCalculation } from '../invalidate-calculation'
import { updateDraftSalaryRun } from '../update-run'

// The step every input write takes has its own suite (invalidate-calculation.test.ts).
vi.mock('@/lib/salary/invalidate-calculation', async (original) => ({
  ...(await original<typeof import('@/lib/salary/invalidate-calculation')>()),
  invalidateRunCalculation: vi.fn(async () => null),
}))

const DRAFT = {
  id: 'run-1',
  status: 'draft',
  period_year: 2026,
  period_month: 7,
  payment_date: '2026-07-25',
  voucher_series: 'L',
  notes: null,
}
const ARGS = { companyId: 'company-1', salaryRunId: 'run-1' }

describe('updateDraftSalaryRun', () => {
  beforeEach(() => {
    vi.mocked(invalidateRunCalculation).mockClear()
  })

  it('writes the patch on a draft, locked on status, and clears the calculation for a supplied payment date', async () => {
    const { supabase, enqueueMany, findCall, findCalls } = createQueuedMockSupabase()
    enqueueMany([{ data: DRAFT }, { data: { ...DRAFT, payment_date: '2026-07-23' } }])

    const result = await updateDraftSalaryRun(supabase as never, { ...ARGS, patch: { payment_date: '2026-07-23' } })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.payment_date).toBe('2026-07-23')
      expect(result.data.previous.payment_date).toBe('2026-07-25')
      expect(result.data.row).toEqual({ ...DRAFT, payment_date: '2026-07-23' })
    }
    expect(findCall('salary_runs', 'update')).toEqual([{ payment_date: '2026-07-23' }])
    expect(findCalls('salary_runs', 'eq')).toContainEqual(['status', 'draft'])
    expect(invalidateRunCalculation).toHaveBeenCalledWith(supabase, 'company-1', { salaryRunId: 'run-1' })
  })

  it('leaves the calculation alone when the patch names no payment date', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: DRAFT }, { data: { ...DRAFT, notes: 'Julbonus' } }])

    await updateDraftSalaryRun(supabase as never, { ...ARGS, patch: { notes: 'Julbonus' } })

    expect(invalidateRunCalculation).not.toHaveBeenCalled()
  })

  it('writes nothing when the calculation could not be cleared', async () => {
    vi.mocked(invalidateRunCalculation).mockResolvedValueOnce({
      ok: false,
      code: 'INTERNAL_ERROR',
      details: { message: 'boom' },
    })
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: DRAFT })

    const result = await updateDraftSalaryRun(supabase as never, { ...ARGS, patch: { payment_date: '2026-07-23' } })

    expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
    expect(findCall('salary_runs', 'update')).toBeUndefined()
  })

  it('reads and returns the caller\'s columns as the row', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    const full = { ...DRAFT, total_gross: 0, created_at: '2026-07-01T00:00:00Z' }
    enqueueMany([{ data: full }, { data: { ...full, notes: 'Julbonus' } }])

    const result = await updateDraftSalaryRun(supabase as never, {
      ...ARGS,
      patch: { notes: 'Julbonus' },
      columns: 'total_gross, created_at',
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.row).toEqual({ ...full, notes: 'Julbonus' })
    expect(findCalls('salary_runs', 'select')[0]).toEqual([
      'id, status, period_year, period_month, payment_date, voucher_series, notes, total_gross, created_at',
    ])
  })

  it('answers an empty patch with the run unchanged and writes nothing', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([{ data: DRAFT }])

    const result = await updateDraftSalaryRun(supabase as never, { ...ARGS, patch: {} })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.row).toEqual(DRAFT)
    expect(findCall('salary_runs', 'update')).toBeUndefined()
  })

  it('refuses a run past draft, and a missing run', async () => {
    const notDraft = createQueuedMockSupabase()
    notDraft.enqueue({ data: { ...DRAFT, status: 'review' } })
    expect(await updateDraftSalaryRun(notDraft.supabase as never, { ...ARGS, patch: { notes: 'x' } })).toEqual({
      ok: false,
      code: 'SALARY_RUN_PATCH_NOT_DRAFT',
      details: { current_status: 'review' },
    })

    const missing = createQueuedMockSupabase()
    missing.enqueue({ data: null })
    expect(await updateDraftSalaryRun(missing.supabase as never, { ...ARGS, patch: { notes: 'x' } })).toEqual({
      ok: false,
      code: 'SALARY_RUN_NOT_FOUND',
    })
  })

  it('refuses a bad value with the field and both languages, before reading the run', async () => {
    const { supabase } = createQueuedMockSupabase()

    const result = await updateDraftSalaryRun(supabase as never, { ...ARGS, patch: { payment_date: '25/7' } })

    expect(result).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: {
        field: 'payment_date',
        message: 'Expected YYYY-MM-DD date format',
        message_sv: 'Ogiltigt datum (ÅÅÅÅ-MM-DD)',
      },
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('answers SALARY_RUN_PATCH_NOT_DRAFT when the run left draft between the read and the write', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: DRAFT }, { data: null }])

    const result = await updateDraftSalaryRun(supabase as never, { ...ARGS, patch: { payment_date: '2026-07-23' } })

    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_PATCH_NOT_DRAFT', details: { reason: 'race' } })
  })
})

describe('updateDraftSalaryRun: several runs in one month', () => {
  const OTHER_RUN = {
    id: 'run-2',
    status: 'booked',
    period_year: 2026,
    period_month: 8,
    payment_date: '2026-08-05',
    run_number: 1,
    corrects_run_id: null,
  }

  beforeEach(() => {
    vi.mocked(invalidateRunCalculation).mockClear()
    process.env.SALARY_EXTRA_RUNS_COMPANY_IDS = 'company-1'
  })

  afterEach(() => {
    delete process.env.SALARY_EXTRA_RUNS_COMPANY_IDS
  })

  it('refuses a payment date that moves the run into a month where another run pays one of its employees', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: DRAFT },
      { data: [OTHER_RUN] }, // the runs of the new payout month (and the period)
      { data: [{ employee_id: 'emp-1' }] }, // this run's roster
      { data: [{ employee_id: 'emp-1', salary_run_id: 'run-2' }] }, // the other run has emp-1
    ])

    const result = await updateDraftSalaryRun(supabase as never, { ...ARGS, patch: { payment_date: '2026-08-04' } })

    expect(result).toMatchObject({
      ok: false,
      code: 'SALARY_RUN_EMPLOYEE_IN_OTHER_RUN',
      details: { other_salary_run_id: 'run-2', employee_ids: ['emp-1'] },
    })
    expect(findCall('salary_runs', 'update')).toBeUndefined()
    expect(invalidateRunCalculation).not.toHaveBeenCalled()
  })

  it('moves the date when no other run of the month has its employees', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: DRAFT },
      { data: [OTHER_RUN] },
      { data: [{ employee_id: 'emp-1' }] },
      { data: [] },
      { data: { ...DRAFT, payment_date: '2026-08-04' } },
    ])

    const result = await updateDraftSalaryRun(supabase as never, { ...ARGS, patch: { payment_date: '2026-08-04' } })

    expect(result.ok).toBe(true)
    expect(findCall('salary_runs', 'update')).toEqual([{ payment_date: '2026-08-04' }])
  })
})
