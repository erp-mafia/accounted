/**
 * lib/salary/mark-paid.ts: approved -> paid, behind the v1 verb
 * POST /salary-runs/{id}/mark-paid and the MCP tool
 * gnubok_mark_salary_run_paid. Only an approved run moves, the write is
 * guarded against a concurrent transition, and a dry run writes nothing.
 * A payment date still ahead needs the caller's confirmation (crm#1216).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { markSalaryRunPaid } from '../mark-paid'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const APPROVED = {
  id: RUN_ID,
  status: 'approved',
  period_year: 2026,
  period_month: 9,
  payment_date: '2026-09-25',
  total_net: 26800,
}

let mock: ReturnType<typeof createTableMockSupabase>
let ctx: { supabase: SupabaseClient; companyId: string }

beforeEach(() => {
  mock = createTableMockSupabase()
  ctx = { supabase: mock.supabase as unknown as SupabaseClient, companyId: COMPANY_ID }
})

describe('markSalaryRunPaid', () => {
  it('answers SALARY_RUN_NOT_FOUND for a run outside the company', async () => {
    mock.setTable('salary_runs', { data: null })
    expect(await markSalaryRunPaid(ctx, RUN_ID)).toEqual({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })
    expect(mock.findCalls('salary_runs', 'eq')).toContainEqual(['company_id', COMPANY_ID])
  })

  it('refuses a run that is not approved, naming its status', async () => {
    mock.setTable('salary_runs', { data: { ...APPROVED, status: 'review' } })
    expect(await markSalaryRunPaid(ctx, RUN_ID)).toEqual({
      ok: false,
      code: 'SALARY_RUN_MARK_PAID_NOT_APPROVED',
      details: { current_status: 'review' },
    })
    expect(mock.findCall('salary_runs', 'update')).toBeUndefined()
  })

  it('previews the transition on a dry run and writes nothing', async () => {
    mock.setTable('salary_runs', { data: APPROVED })

    const result = await markSalaryRunPaid(ctx, RUN_ID, { dryRun: true })

    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      preview: {
        salary_run_id: RUN_ID,
        would_advance_status_from: 'approved',
        would_advance_status_to: 'paid',
        period_year: 2026,
        period_month: 9,
        payment_date: '2026-09-25',
        total_net: 26800,
      },
    })
    expect(mock.findCall('salary_runs', 'update')).toBeUndefined()
  })

  it('moves an approved run to paid with the server clock, guarded on approved', async () => {
    const paid = { id: RUN_ID, status: 'paid', paid_at: '2026-09-25T08:00:00.000Z' }
    mock.setTable('salary_runs', [{ data: APPROVED }, { data: paid }])

    const result = await markSalaryRunPaid(ctx, RUN_ID)

    expect(result).toEqual({ ok: true, data: paid })
    const [patch] = mock.findCall('salary_runs', 'update') as [{ status: string; paid_at: string }]
    expect(patch.status).toBe('paid')
    expect(new Date(patch.paid_at).toISOString()).toBe(patch.paid_at)
    expect(mock.findCalls('salary_runs', 'eq')).toContainEqual(['status', 'approved'])
    expect(mock.findCalls('salary_runs', 'select')).toContainEqual(['id, status, paid_at'])
  })

  it('reports a run that moved on between the read and the write as a race', async () => {
    mock.setTable('salary_runs', [{ data: APPROVED }, { data: null }])
    expect(await markSalaryRunPaid(ctx, RUN_ID)).toEqual({
      ok: false,
      code: 'SALARY_RUN_MARK_PAID_NOT_APPROVED',
      details: { reason: 'race' },
    })
  })

  it('hands database errors to the door', async () => {
    const readError = { code: '57014', message: 'statement timeout' }
    mock.setTable('salary_runs', { error: readError })
    expect(await markSalaryRunPaid(ctx, RUN_ID)).toEqual({ ok: false, code: 'UNKNOWN_ERROR', error: readError })

    const writeError = { code: '40P01', message: 'deadlock detected' }
    mock.setTable('salary_runs', [{ data: APPROVED }, { error: writeError }])
    expect(await markSalaryRunPaid(ctx, RUN_ID)).toEqual({ ok: false, code: 'UNKNOWN_ERROR', error: writeError })
  })
})

describe('markSalaryRunPaid with the payment date still ahead (crm#1216)', () => {
  const AHEAD = { ...APPROVED, payment_date: '2026-10-23' }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-15T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refuses without the confirmation and writes nothing', async () => {
    mock.setTable('salary_runs', { data: AHEAD })
    expect(await markSalaryRunPaid(ctx, RUN_ID)).toEqual({
      ok: false,
      code: 'SALARY_RUN_PAYMENT_DATE_AHEAD_UNCONFIRMED',
      details: { payment_date: '2026-10-23', today: '2026-10-15' },
    })
    expect(mock.findCall('salary_runs', 'update')).toBeUndefined()
  })

  it('refuses on a dry run too, so an MCP stage fails before it reaches the approver', async () => {
    mock.setTable('salary_runs', { data: AHEAD })
    const result = await markSalaryRunPaid(ctx, RUN_ID, { dryRun: true })
    expect(result).toMatchObject({ ok: false, code: 'SALARY_RUN_PAYMENT_DATE_AHEAD_UNCONFIRMED' })
  })

  it('marks a confirmed run paid', async () => {
    const paid = { id: RUN_ID, status: 'paid', paid_at: '2026-10-15T10:00:00.000Z' }
    mock.setTable('salary_runs', [{ data: AHEAD }, { data: paid }])
    expect(await markSalaryRunPaid(ctx, RUN_ID, { confirmPaymentDateAhead: true })).toEqual({ ok: true, data: paid })
  })

  it('needs no confirmation for a run with nothing paid out', async () => {
    const paid = { id: RUN_ID, status: 'paid', paid_at: '2026-10-15T10:00:00.000Z' }
    mock.setTable('salary_runs', [{ data: { ...AHEAD, total_net: 0 } }, { data: paid }])
    expect(await markSalaryRunPaid(ctx, RUN_ID)).toEqual({ ok: true, data: paid })
  })

  it('needs no confirmation on the payment date itself', async () => {
    vi.setSystemTime(new Date('2026-10-23T05:00:00Z'))
    const paid = { id: RUN_ID, status: 'paid', paid_at: '2026-10-23T05:00:00.000Z' }
    mock.setTable('salary_runs', [{ data: AHEAD }, { data: paid }])
    expect(await markSalaryRunPaid(ctx, RUN_ID)).toEqual({ ok: true, data: paid })
  })
})
