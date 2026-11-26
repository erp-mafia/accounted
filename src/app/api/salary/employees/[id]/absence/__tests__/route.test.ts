/**
 * Auth-wiring tests for /api/salary/employees/[id]/absence (POST upsert).
 *
 * Runs the route through the real withRouteContext wrapper; mocks auth/company/
 * write and injects a queued Supabase mock via requireAuth. Covers 401, 403
 * (viewer), and a POST happy path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { POST } from '../route'

// The step every input write takes has its own suite (invalidate-calculation.test.ts).
vi.mock('@/lib/salary/invalidate-calculation', async (original) => ({
  ...(await original<typeof import('@/lib/salary/invalidate-calculation')>()),
  invalidateRunCalculation: vi.fn(async () => null),
}))

const params = { params: Promise.resolve({ id: 'emp-1' }) } as never

/** The register-lock lookups every write makes right after the employee check: runs, then the registered day. */
const enqueueNoLockingRuns = () => {
  enqueue({ data: [] })
  enqueue({ data: [] })
}

/** October 2026, booked: its days are paid out. */
const BOOKED_RUN_OCTOBER = {
  id: 'run-oct',
  status: 'booked',
  period_year: 2026,
  period_month: 10,
  deviation_period_start: '2026-10-01',
  deviation_period_end: '2026-10-31',
  agi_submitted_at: null,
  corrects_run_id: null,
}

/** November 2026, the draft the payslip calendar works in. */
const DRAFT_RUN_NOVEMBER = {
  id: 'run-nov',
  status: 'draft',
  period_year: 2026,
  period_month: 11,
  deviation_period_start: '2026-11-01',
  deviation_period_end: '2026-11-30',
  agi_submitted_at: null,
  corrects_run_id: null,
}

/** July 2026 pay month, calculated, legacy NULL window: locks 2026-07-01..31. */
const REVIEW_RUN_JULY = {
  id: 'run-jul',
  status: 'review',
  period_year: 2026,
  period_month: 7,
  deviation_period_start: null,
  deviation_period_end: null,
}

function post(body: unknown) {
  return createMockRequest('/api/salary/employees/emp-1/absence', { method: 'POST', body })
}

describe('POST /api/salary/employees/[id]/absence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(post({ absence_date: '2026-07-01', absence_type: 'sick', hours: 8 }), params)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(post({ absence_date: '2026-07-01', absence_type: 'sick', hours: 8 }), params)
    expect(response.status).toBe(403)
  })

  it('upserts an absence day (happy path)', async () => {
    enqueue({ data: { id: 'emp-1' } }) // loadEmployee
    enqueueNoLockingRuns()
    enqueue({ data: { id: 'abs-1', absence_date: '2026-07-01', absence_type: 'sick', hours: 8 } }) // upsert

    const response = await POST(post({ absence_date: '2026-07-01', absence_type: 'sick', hours: 8 }), params)
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)

    expect(status).toBe(201)
    expect(body.data.id).toBe('abs-1')
  })

  it('takes one scheduled day of the employee when the hours are left out', async () => {
    enqueue({ data: { id: 'emp-1', hours_per_week: 40, workdays_per_week: 4 } }) // loadEmployee
    enqueueNoLockingRuns()
    enqueue({ data: { id: 'abs-1', absence_date: '2026-07-01', absence_type: 'sick', hours: 10 } }) // upsert

    const response = await POST(post({ absence_date: '2026-07-01', absence_type: 'sick' }), params)

    expect(response.status).toBe(201)
    expect(findCall('salary_absence_days', 'upsert')?.[0]).toMatchObject({ hours: 10 })
  })

  it('returns 400 for hours above a day', async () => {
    const response = await POST(post({ absence_date: '2026-07-01', absence_type: 'sick', hours: 25 }), params)
    expect(response.status).toBe(400)
  })

  it('returns 404 when the employee is not in the company', async () => {
    enqueue({ data: null }) // loadEmployee → not found

    const response = await POST(post({ absence_date: '2026-07-01', absence_type: 'sick', hours: 8 }), params)
    expect(response.status).toBe(404)
  })

  it('does not leak raw PG text for DB failures (42501)', async () => {
    enqueue({ data: { id: 'emp-1' } }) // loadEmployee
    enqueueNoLockingRuns()
    enqueue({
      data: null,
      error: {
        code: '42501',
        message:
          'new row violates row-level security policy for table "salary_absence_franvaro_audit"',
      },
    }) // upsert denied

    const response = await POST(post({ absence_date: '2026-07-01', absence_type: 'parental', hours: 8 }), params)
    const { status, body } = await parseJsonResponse<{ error: string; code: string }>(response)

    expect(status).toBe(500)
    expect(body.code).toBe('DB_PERMISSION_DENIED')
    expect(body.error).not.toMatch(/row-level security/)
    // The registry's Swedish message is shown instead.
    expect(body.error).toContain('behörighetsfel')
  })

  it('still passes the 24h-cap trigger detail through (Swedish, user-facing)', async () => {
    enqueue({ data: { id: 'emp-1' } }) // loadEmployee
    enqueueNoLockingRuns()
    enqueue({
      data: null,
      error: {
        code: '23514',
        message: 'Total tid (arbete + frånvaro) för 2026-07-01 får inte överstiga 24 timmar',
      },
    }) // 24h cap trips

    const response = await POST(post({ absence_date: '2026-07-01', absence_type: 'sick', hours: 20 }), params)
    const { status, body } = await parseJsonResponse<{ error: string; code: string }>(response)

    expect(status).toBe(409)
    expect(body.code).toBe('ABSENCE_HOURS_CONFLICT')
    expect(body.error).toContain('Total tid')
  })

  it('returns 409 with the Swedish message and the run when a calculated run already read the date', async () => {
    enqueue({ data: { id: 'emp-1' } }) // loadEmployee
    enqueue({ data: [REVIEW_RUN_JULY] }) // register lock lookup
    enqueue({ data: [] }) // nothing registered on the day

    const response = await POST(post({ absence_date: '2026-07-01', absence_type: 'sick', hours: 8 }), params)
    const { status, body } = await parseJsonResponse<{
      error: string
      code: string
      details: { salary_run_id: string; locked_dates: string[] }
    }>(response)

    expect(status).toBe(409)
    expect(body.code).toBe('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
    expect(body.error).toContain('lönekörning 2026-07 (beräknad)')
    expect(body.error).toContain('Återställ den till utkast')
    expect(body.details).toMatchObject({ salary_run_id: 'run-jul', locked_dates: ['2026-07-01'] })
    // Nothing was written.
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['employees', 'salary_runs', 'salary_absence_days'])
    expect(findCall('salary_absence_days', 'upsert')).toBeUndefined()
  })

  it('refuses a late day outside a payslip and says where it is registered', async () => {
    enqueue({ data: { id: 'emp-1' } }) // loadEmployee
    enqueue({ data: [BOOKED_RUN_OCTOBER, DRAFT_RUN_NOVEMBER] }) // runs
    enqueue({ data: [] }) // nothing registered on the day

    const response = await POST(post({ absence_date: '2026-10-19', absence_type: 'parental', hours: 8 }), params)
    const { status, body } = await parseJsonResponse<{ error: string; code: string; details: Record<string, unknown> }>(response)

    expect(status).toBe(409)
    expect(body.code).toBe('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
    expect(body.error).toContain('2026-11 (utkast)')
    expect(body.error).toContain('kalendern på lönebeskedet')
    expect(body.details).toMatchObject({ reason: 'late_day_needs_later_run' })
    expect(findCall('salary_absence_days', 'upsert')).toBeUndefined()
  })

  it("carries a late day registered from a draft payslip's calendar to that payslip's run", async () => {
    enqueue({ data: { salary_run_id: 'run-nov' } }) // the payslip's run
    enqueue({ data: { id: 'emp-1' } }) // loadEmployee
    enqueue({ data: [BOOKED_RUN_OCTOBER, DRAFT_RUN_NOVEMBER] }) // runs
    enqueue({ data: [] }) // nothing registered on the day
    enqueue({ data: [{ salary_run_id: 'run-nov', salary_type: 'monthly' }, { salary_run_id: 'run-oct', salary_type: 'monthly' }] }) // the employee's payslips: on November, and October paid them monthly
    enqueue({ data: { salary_calculation_policy: {} } })
    enqueue({ data: { id: 'abs-1', absence_date: '2026-10-19', absence_type: 'parental', hours: 8, carried_to_run_id: 'run-nov' } })

    const response = await POST(
      post({ absence_date: '2026-10-19', absence_type: 'parental', hours: 8, salary_run_employee_id: '11111111-1111-4111-8111-111111111111' }),
      params,
    )

    expect(response.status).toBe(201)
    expect(findCall('salary_absence_days', 'upsert')?.[0]).toMatchObject({
      absence_date: '2026-10-19',
      carried_to_run_id: 'run-nov',
    })
  })
})
