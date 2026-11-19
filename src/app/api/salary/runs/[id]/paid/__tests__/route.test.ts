/**
 * POST /api/salary/runs/[id]/paid: approved -> paid through the shared rule
 * in lib/salary/mark-paid.ts. crm#1216: a run whose payment date has not come
 * is refused unless the run page's "Har lönen redan betalats ut?" answer
 * comes with the request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function authed(supabase: unknown) {
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
}

const approvedRun = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1',
  status: 'approved',
  period_year: 2026,
  period_month: 9,
  payment_date: '2026-09-25',
  total_net: 23000,
  ...overrides,
})

const paidRow = { id: 'run-1', status: 'paid', paid_at: '2026-09-25T08:00:00.000Z' }

function post(body?: unknown) {
  const request = createMockRequest('/api/salary/runs/run-1/paid', { method: 'POST', body })
  return POST(request, createMockRouteParams({ id: 'run-1' }))
}

describe('POST /api/salary/runs/[id]/paid', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: {} as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const { status } = await parseJsonResponse(await post())

    expect(status).toBe(401)
  })

  it('returns 404 SALARY_RUN_NOT_FOUND for a run outside the company', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    authed(supabase)
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())

    expect(status).toBe(404)
    expect(body.error.code).toBe('SALARY_RUN_NOT_FOUND')
    expect(findCalls('salary_runs', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('returns 400 when the run is not approved, and writes nothing', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    authed(supabase)
    enqueue({ data: approvedRun({ status: 'review' }) })

    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(await post())

    expect(status).toBe(400)
    expect(body.error.code).toBe('SALARY_RUN_MARK_PAID_NOT_APPROVED')
    expect(body.error.message).toContain('måste vara godkänd')
    expect(findCall('salary_runs', 'update')).toBeUndefined()
  })

  it('marks an approved run paid once its payment date has come', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    authed(supabase)
    enqueueMany([{ data: approvedRun() }, { data: paidRow }])

    const { status, body } = await parseJsonResponse<{ data: typeof paidRow }>(await post())

    expect(status).toBe(200)
    expect(body.data).toEqual(paidRow)
    const [patch] = findCall('salary_runs', 'update') as [{ status: string }]
    expect(patch.status).toBe('paid')
  })

  it('refuses a payment date ahead with 422 in Swedish without the confirmation', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    authed(supabase)
    enqueue({ data: approvedRun({ payment_date: '2999-12-31' }) })

    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; details: Record<string, unknown> }
    }>(await post())

    expect(status).toBe(422)
    expect(body.error.code).toBe('SALARY_RUN_PAYMENT_DATE_AHEAD_UNCONFIRMED')
    expect(body.error.message).toContain('utbetalningsdag har inte kommit än')
    expect(body.error.details.payment_date).toBe('2999-12-31')
    expect(findCall('salary_runs', 'update')).toBeUndefined()
  })

  it('treats a confirmation that is not literally true as missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    authed(supabase)
    enqueue({ data: approvedRun({ payment_date: '2999-12-31' }) })

    const { status } = await parseJsonResponse(await post({ confirm_payment_date_ahead: 'yes' }))

    expect(status).toBe(422)
  })

  it('marks a run with the payment date ahead paid when the request confirms it', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    authed(supabase)
    enqueueMany([{ data: approvedRun({ payment_date: '2999-12-31' }) }, { data: paidRow }])

    const { status, body } = await parseJsonResponse<{ data: typeof paidRow }>(
      await post({ confirm_payment_date_ahead: true }),
    )

    expect(status).toBe(200)
    expect(body.data.status).toBe('paid')
  })
})
