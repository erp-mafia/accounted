import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
} from '@/tests/helpers'

// withRouteContext dependencies.
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/events', () => ({ eventBus: { emit: vi.fn().mockResolvedValue(undefined) } }))
// The seeding + calculation libs have their own tests - stub them here and
// assert on the wiring (defaults, conflict handling, non-fatal calc).
vi.mock('@/lib/salary/create-run', () => ({ createSalaryRunWithEmployees: vi.fn() }))
vi.mock('@/lib/salary/run-calculation', () => ({ runSalaryCalculation: vi.fn() }))

import { GET, POST } from '../route'
import { eventBus } from '@/lib/events'
import { requireAuth } from '@/lib/auth/require-auth'
import { createSalaryRunWithEmployees } from '@/lib/salary/create-run'
import { runSalaryCalculation } from '@/lib/salary/run-calculation'
import { SalaryDeviationPeriodError } from '@/lib/salary/deviation-period'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/** The rollout as the environment had it, restored after each test that sets it. */
const rolloutBefore = process.env.SALARY_EXTRA_RUNS_COMPANY_IDS

const mockUser = { id: 'user-1', email: 'test@test.se' }

function authed(supabase: unknown) {
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  } as never)
}

function post(body: unknown = {}) {
  return createMockRequest('/api/salary/runs', { method: 'POST', body })
}

const CREATED_RUN = { id: 'run-new', period_year: 2026, period_month: 7, status: 'draft' }

describe('POST /api/salary/runs — one-click creation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createSalaryRunWithEmployees).mockResolvedValue({
      run: { ...CREATED_RUN },
      employeeCount: 3,
      deviationWindow: { start: '2026-07-01', end: '2026-07-31' },
    })
    vi.mocked(runSalaryCalculation).mockResolvedValue({
      ok: true,
      run: { ...CREATED_RUN, total_gross: 105000 },
      warnings: [],
    })
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)

    const response = await POST(post(), { params: Promise.resolve({}) } as never)
    expect(response.status).toBe(401)
  })

  it('rejects an invalid body with 400', async () => {
    const { supabase } = createQueuedMockSupabase()
    authed(supabase)

    const response = await POST(post({ period_month: 13 }), {
      params: Promise.resolve({}),
    } as never)
    expect(response.status).toBe(400)
    expect(createSalaryRunWithEmployees).not.toHaveBeenCalled()
  })

  it('resolves defaults from settings + latest run when body is {}', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      // settings: pay day 27
      { data: { salary_pay_day: 27 } },
      // latest non-corrected run: 2026-06 → defaults resolve to 2026-07
      { data: { period_year: 2026, period_month: 6 } },
      // conflict pre-check: none
      { data: null },
    ])

    const response = await POST(post({}), { params: Promise.resolve({}) } as never)
    const { status, body } = await parseJsonResponse<{
      data: { total_gross?: number }
      employee_count: number
      calculation: { ok: boolean }
    }>(response)

    expect(status).toBe(201)
    expect(body.employee_count).toBe(3)
    expect(body.calculation.ok).toBe(true)
    // Calculation succeeded → recalculated row is returned
    expect(body.data.total_gross).toBe(105000)

    // No series in the body: the lib resolves the company's salary series,
    // the same rule v1 and MCP use, and emits salary_run.created itself.
    expect(createSalaryRunWithEmployees).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 7,
      paymentDate: '2026-07-27',
      voucherSeries: undefined,
      notes: undefined,
    })
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('rolls December forward into January of the next year', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: null }, // no settings row → pay day 25
      { data: { period_year: 2026, period_month: 12 } },
      { data: null },
    ])

    const response = await POST(post({}), { params: Promise.resolve({}) } as never)
    expect(response.status).toBe(201)
    expect(createSalaryRunWithEmployees).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ periodYear: 2027, periodMonth: 1, paymentDate: '2027-01-25', voucherSeries: undefined }),
    )
  })

  it('starts with the current month when the company has no run yet', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 21, 12, 0))
    try {
      const { supabase, enqueueMany } = createQueuedMockSupabase()
      authed(supabase)

      enqueueMany([
        { data: null }, // no settings row
        { data: null }, // no latest run
        { data: null }, // conflict pre-check: none
      ])

      const response = await POST(post({}), { params: Promise.resolve({}) } as never)
      expect(response.status).toBe(201)
      expect(createSalaryRunWithEmployees).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        'user-1',
        expect.objectContaining({ periodYear: 2026, periodMonth: 9, paymentDate: '2026-09-25' }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('explicit body fields win over defaults', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: { salary_pay_day: 27 } },
      // no latest-run lookup - period was explicit
      { data: null }, // conflict pre-check
    ])

    const response = await POST(
      post({ period_year: 2026, period_month: 3, payment_date: '2026-03-24', voucher_series: 'B' }),
      { params: Promise.resolve({}) } as never,
    )
    expect(response.status).toBe(201)
    expect(createSalaryRunWithEmployees).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        periodYear: 2026,
        periodMonth: 3,
        paymentDate: '2026-03-24',
        voucherSeries: 'B',
      }),
    )
  })

  it('creates a chosen earlier month with the pay day in that month (crm#1001)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: { salary_pay_day: 27 } },
      // no latest-run lookup: the period was chosen
      { data: null }, // conflict pre-check: the month is free
    ])

    const response = await POST(post({ period_year: 2026, period_month: 8 }), {
      params: Promise.resolve({}),
    } as never)
    expect(response.status).toBe(201)
    // The payment date follows the chosen month, so the AGI period and the
    // verifikat date (both read from payment_date) land in that month too.
    expect(createSalaryRunWithEmployees).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ periodYear: 2026, periodMonth: 8, paymentDate: '2026-08-27' }),
    )
  })

  it('passes explicit deviation_period dates through to the lib', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)
    enqueueMany([{ data: null }, { data: null }])

    const response = await POST(
      post({
        period_year: 2026,
        period_month: 9,
        payment_date: '2026-09-25',
        deviation_period_start: '2026-08-01',
        deviation_period_end: '2026-08-31',
      }),
      { params: Promise.resolve({}) } as never,
    )
    expect(response.status).toBe(201)
    expect(createSalaryRunWithEmployees).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        deviationPeriodStart: '2026-08-01',
        deviationPeriodEnd: '2026-08-31',
      }),
    )
  })

  it('maps an overlapping avvikelseperiod to 409 with the conflicting run', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)
    enqueueMany([{ data: null }, { data: null }])
    vi.mocked(createSalaryRunWithEmployees).mockRejectedValueOnce(
      new SalaryDeviationPeriodError('SALARY_RUN_DEVIATION_PERIOD_OVERLAP', 'overlap', {
        conflicting_run_id: 'run-aug',
      }),
    )

    const response = await POST(
      post({ period_year: 2026, period_month: 9, payment_date: '2026-09-25' }),
      { params: Promise.resolve({}) } as never,
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { conflicting_run_id?: string } }
    }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALARY_RUN_DEVIATION_PERIOD_OVERLAP')
    expect(body.error.details?.conflicting_run_id).toBe('run-aug')
    expect(runSalaryCalculation).not.toHaveBeenCalled()
  })

  it('creates an extra run beside the period\'s run when the body asks for one', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)
    enqueueMany([{ data: null }]) // settings: no duplicate pre-check for an extra run

    const response = await POST(
      post({ period_year: 2026, period_month: 6, payment_date: '2026-06-26', extra_run: true }),
      { params: Promise.resolve({}) } as never,
    )

    expect(response.status).toBe(201)
    expect(createSalaryRunWithEmployees).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({ periodYear: 2026, periodMonth: 6, paymentDate: '2026-06-26', extraRun: true }),
    )
  })

  it('answers 409 SALARY_EXTRA_RUN_UNAVAILABLE when the company has no extra runs', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)
    enqueueMany([{ data: null }])
    vi.mocked(createSalaryRunWithEmployees).mockRejectedValueOnce(
      Object.assign(new Error('not switched on'), { name: 'SalaryExtraRunError', reason: 'not_enabled' }),
    )

    const response = await POST(
      post({ period_year: 2026, period_month: 6, payment_date: '2026-06-26', extra_run: true }),
      { params: Promise.resolve({}) } as never,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { reason: string } } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('SALARY_EXTRA_RUN_UNAVAILABLE')
    expect(body.error.details.reason).toBe('not_enabled')
  })

  it('refuses an extra run that names no period', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)
    enqueueMany([{ data: null }])

    const response = await POST(post({ extra_run: true }), { params: Promise.resolve({}) } as never)

    expect(response.status).toBe(400)
    expect(createSalaryRunWithEmployees).not.toHaveBeenCalled()
  })

  it('refuses a non-boolean extra_run with 400', async () => {
    const { supabase } = createQueuedMockSupabase()
    authed(supabase)

    const response = await POST(post({ extra_run: 'yes' }), { params: Promise.resolve({}) } as never)

    expect(response.status).toBe(400)
    expect(createSalaryRunWithEmployees).not.toHaveBeenCalled()
  })

  it('returns 409 with existingId when an active run exists for the period', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: null }, // settings
      { data: { id: 'run-existing' } }, // conflict pre-check hit (explicit period)
    ])

    const response = await POST(
      post({ period_year: 2026, period_month: 6, payment_date: '2026-06-25' }),
      { params: Promise.resolve({}) } as never,
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; details: { existingId: string; reason: string } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('SALARY_RUN_DUPLICATE_PERIOD')
    expect(body.error.message).toBe('Det finns redan en lönekörning för 2026-06.')
    expect(body.error.details.existingId).toBe('run-existing')
    expect(body.error.details.reason).toBe('salary_run_exists_for_period')
    expect(createSalaryRunWithEmployees).not.toHaveBeenCalled()

    // The page shows the refusal through the shared error mapping.
    expect(getErrorMessage(body, { context: 'salary', statusCode: 409, locale: 'sv' })).toBe(
      'Det finns redan en lönekörning för 2026-06.',
    )
    expect(getErrorMessage(body, { context: 'salary', statusCode: 409, locale: 'en' })).toBe(
      'A salary run for that period already exists.',
    )
  })

  it('maps a create race (lib 23505 message) to 409', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)
    vi.mocked(createSalaryRunWithEmployees).mockRejectedValue(
      new Error('Salary run already exists for this period'),
    )

    enqueueMany([
      { data: null }, // settings
      { data: null }, // conflict pre-check (race: passes)
    ])

    const response = await POST(
      post({ period_year: 2026, period_month: 6, payment_date: '2026-06-25' }),
      { params: Promise.resolve({}) } as never,
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; details: { existingId?: string } }
    }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALARY_RUN_DUPLICATE_PERIOD')
    expect(body.error.message).toBe('Det finns redan en lönekörning för 2026-06.')
    expect(body.error.details.existingId).toBeUndefined()
  })

  it('puts the existing run id in the 409 when the lib names the race winner', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)
    const raceErr = Object.assign(
      new Error('Salary run already exists for this period (id run-winner, status draft)'),
      { name: 'SalaryRunExistsError', existingId: 'run-winner', existingStatus: 'draft' },
    )
    vi.mocked(createSalaryRunWithEmployees).mockRejectedValue(raceErr)

    enqueueMany([
      { data: null }, // settings
      { data: null }, // conflict pre-check (race: passes)
    ])

    const response = await POST(
      post({ period_year: 2026, period_month: 6, payment_date: '2026-06-25' }),
      { params: Promise.resolve({}) } as never,
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { existingId?: string; existingStatus?: string } }
    }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('SALARY_RUN_DUPLICATE_PERIOD')
    expect(body.error.details.existingId).toBe('run-winner')
    expect(body.error.details.existingStatus).toBe('draft')
  })

  it('still returns 201 when the chained calculation fails', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)
    vi.mocked(runSalaryCalculation).mockResolvedValue({
      ok: false,
      code: 'SALARY_RUN_TAX_TABLE_MISSING',
    })

    enqueueMany([
      { data: null },
      { data: null },
    ])

    const response = await POST(
      post({ period_year: 2026, period_month: 6, payment_date: '2026-06-25' }),
      { params: Promise.resolve({}) } as never,
    )
    const { status, body } = await parseJsonResponse<{
      data: { id: string }
      calculation: { ok: boolean; code?: string }
    }>(response)

    expect(status).toBe(201)
    expect(body.data.id).toBe('run-new')
    expect(body.calculation).toEqual({ ok: false, code: 'SALARY_RUN_TAX_TABLE_MISSING' })
  })
})

describe('GET /api/salary/runs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (rolloutBefore === undefined) delete process.env.SALARY_EXTRA_RUNS_COMPANY_IDS
    else process.env.SALARY_EXTRA_RUNS_COMPANY_IDS = rolloutBefore
  })

  it('says whether the company may start an extra run in a month that has one', async () => {
    delete process.env.SALARY_EXTRA_RUNS_COMPANY_IDS
    const off = createQueuedMockSupabase()
    authed(off.supabase)
    off.enqueue({ data: [{ id: 'run-1' }] })
    const closed = await parseJsonResponse<{ data: unknown[]; extra_runs: boolean }>(
      await GET(createMockRequest('/api/salary/runs'), { params: Promise.resolve({}) } as never),
    )
    expect(closed.status).toBe(200)
    expect(closed.body).toEqual({ data: [{ id: 'run-1' }], extra_runs: false })

    process.env.SALARY_EXTRA_RUNS_COMPANY_IDS = 'company-1'
    const on = createQueuedMockSupabase()
    authed(on.supabase)
    on.enqueue({ data: [] })
    const open = await parseJsonResponse<{ extra_runs: boolean }>(
      await GET(createMockRequest('/api/salary/runs'), { params: Promise.resolve({}) } as never),
    )
    expect(open.body.extra_runs).toBe(true)
  })
})
