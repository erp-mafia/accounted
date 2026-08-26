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

const { supabase, enqueue, reset } = createQueuedMockSupabase()

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

const params = { params: Promise.resolve({ id: 'emp-1' }) } as never

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
    enqueue({ data: { id: 'abs-1', absence_date: '2026-07-01', absence_type: 'sick', hours: 8 } }) // upsert

    const response = await POST(post({ absence_date: '2026-07-01', absence_type: 'sick', hours: 8 }), params)
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)

    expect(status).toBe(201)
    expect(body.data.id).toBe('abs-1')
  })

  it('returns 404 when the employee is not in the company', async () => {
    enqueue({ data: null }) // loadEmployee → not found

    const response = await POST(post({ absence_date: '2026-07-01', absence_type: 'sick', hours: 8 }), params)
    expect(response.status).toBe(404)
  })

  it('does not leak raw PG text for DB failures (42501)', async () => {
    enqueue({ data: { id: 'emp-1' } }) // loadEmployee
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
})
