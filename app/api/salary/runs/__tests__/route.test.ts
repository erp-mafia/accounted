import { describe, it, expect, vi, beforeEach } from 'vitest'
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
// The seeding + calculation libs have their own tests — stub them here and
// assert on the wiring (defaults, conflict handling, non-fatal calc).
vi.mock('@/lib/salary/create-run', () => ({ createSalaryRunWithEmployees: vi.fn() }))
vi.mock('@/lib/salary/run-calculation', () => ({ runSalaryCalculation: vi.fn() }))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { createSalaryRunWithEmployees } from '@/lib/salary/create-run'
import { runSalaryCalculation } from '@/lib/salary/run-calculation'

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
      // settings: pay day 27, salary series L
      {
        data: {
          salary_pay_day: 27,
          default_voucher_series_per_source_type: { salary_payment: 'L' },
        },
      },
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

    expect(createSalaryRunWithEmployees).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', {
      periodYear: 2026,
      periodMonth: 7,
      paymentDate: '2026-07-27',
      voucherSeries: 'L',
      notes: undefined,
    })
  })

  it('rolls December forward into January of the next year', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: null }, // no settings row → pay day 25, series 'A'
      { data: { period_year: 2026, period_month: 12 } },
      { data: null },
    ])

    const response = await POST(post({}), { params: Promise.resolve({}) } as never)
    expect(response.status).toBe(201)
    expect(createSalaryRunWithEmployees).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ periodYear: 2027, periodMonth: 1, paymentDate: '2027-01-25', voucherSeries: 'A' }),
    )
  })

  it('explicit body fields win over defaults', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)

    enqueueMany([
      { data: { salary_pay_day: 27, default_voucher_series_per_source_type: { salary_payment: 'L' } } },
      // no latest-run lookup — period was explicit
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
      error: { code: string; details: { existingId: string } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('CONFLICT')
    expect(body.error.details.existingId).toBe('run-existing')
    expect(createSalaryRunWithEmployees).not.toHaveBeenCalled()
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
    expect(response.status).toBe(409)
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
