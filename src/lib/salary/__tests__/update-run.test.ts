/**
 * updateDraftSalaryRun (lib/salary/update-run.ts): the one draft-header edit
 * behind the dashboard PATCH, the v1 PATCH and the MCP update tool.
 */
import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { updateDraftSalaryRun } from '../update-run'

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
  it('writes the patch on a draft, locked on status, and clears the calculation for a supplied payment date', async () => {
    const { supabase, enqueueMany, findCall, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: DRAFT },
      { data: { ...DRAFT, payment_date: '2026-07-23' } },
      { data: null }, // calculation_breakdown clear
    ])

    const result = await updateDraftSalaryRun(supabase as never, { ...ARGS, patch: { payment_date: '2026-07-23' } })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.payment_date).toBe('2026-07-23')
      expect(result.data.previous.payment_date).toBe('2026-07-25')
      expect(result.data.row).toEqual({ ...DRAFT, payment_date: '2026-07-23' })
    }
    expect(findCall('salary_runs', 'update')).toEqual([{ payment_date: '2026-07-23' }])
    expect(findCalls('salary_runs', 'eq')).toContainEqual(['status', 'draft'])
    expect(findCall('salary_run_employees', 'update')).toEqual([{ calculation_breakdown: null }])
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
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([{ data: DRAFT }, { data: null }])

    const result = await updateDraftSalaryRun(supabase as never, { ...ARGS, patch: { payment_date: '2026-07-23' } })

    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_PATCH_NOT_DRAFT', details: { reason: 'race' } })
    expect(findCall('salary_run_employees', 'update')).toBeUndefined()
  })
})
