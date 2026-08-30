/**
 * Auth-wiring tests for /api/salary/employees/[id]/recurring-lines (POST
 * create). Runs the route through the real withRouteContext wrapper; mocks
 * auth/company/write and injects a queued Supabase mock via requireAuth.
 * Covers 401, 403 (viewer), the POST happy path, and the schema mirrors of
 * the table CHECKs (amount sign, validity period).
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
  return createMockRequest('/api/salary/employees/emp-1/recurring-lines', { method: 'POST', body })
}

const validLine = {
  item_type: 'gross_deduction_other',
  description: 'Förmånscykel bruttolöneavdrag',
  amount: -670.17,
  valid_from: '2026-01-01',
}

describe('POST /api/salary/employees/[id]/recurring-lines', () => {
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

    const response = await POST(post(validLine), params)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(post(validLine), params)
    expect(response.status).toBe(403)
  })

  it('creates a recurring line (happy path)', async () => {
    enqueue({ data: { id: 'emp-1' } }) // employee ownership check
    enqueue({ data: { id: 'line-1', item_type: 'gross_deduction_other', amount: -670.17 } }) // insert

    const response = await POST(post(validLine), params)
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)

    expect(status).toBe(201)
    expect(body.data.id).toBe('line-1')
  })

  it('returns 404 when the employee is not in the company', async () => {
    enqueue({ data: null }) // employee ownership check → zero rows, no error

    const response = await POST(post(validLine), params)
    expect(response.status).toBe(404)
  })

  it('reports an employee-lookup failure as 500, not 404', async () => {
    enqueue({ data: null, error: { code: '08006', message: 'connection failure' } })

    const response = await POST(post(validLine), params)
    expect(response.status).toBe(500)
  })

  // Amount sign: mirrors the employee_recurring_lines_amount_sign CHECK.
  describe('amount sign', () => {
    it('rejects a positive amount on a deduction type with a field-level 400', async () => {
      const response = await POST(post({ ...validLine, amount: 670.17 }), params)
      const { status, body } = await parseJsonResponse<{
        errors: { field: string }[]
      }>(response)

      expect(status).toBe(400)
      expect(body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'amount' })]),
      )
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects a negative amount on a recurring addition', async () => {
      const response = await POST(
        post({ ...validLine, item_type: 'other', amount: -500 }),
        params,
      )
      expect(response.status).toBe(400)
    })

    it('rejects zero for every item type', async () => {
      const response = await POST(post({ ...validLine, amount: 0 }), params)
      expect(response.status).toBe(400)
    })
  })

  // Validity period: mirrors CHECK (valid_to IS NULL OR valid_to >= valid_from).
  describe('valid_from / valid_to ordering', () => {
    it('rejects valid_to before valid_from with an actionable 400', async () => {
      const response = await POST(
        post({ ...validLine, valid_from: '2026-06-01', valid_to: '2026-05-31' }),
        params,
      )
      const { status, body } = await parseJsonResponse<{
        error: string
        errors: { field: string; message: string }[]
      }>(response)

      expect(status).toBe(400)
      expect(body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'valid_to' })]),
      )
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('accepts valid_to equal to valid_from (the bound is inclusive)', async () => {
      enqueue({ data: { id: 'emp-1' } })
      enqueue({ data: { id: 'line-1' } })

      const response = await POST(
        post({ ...validLine, valid_from: '2026-06-01', valid_to: '2026-06-01' }),
        params,
      )
      expect(response.status).toBe(201)
    })

    it('accepts an omitted valid_to (open-ended line stays legal)', async () => {
      enqueue({ data: { id: 'emp-1' } })
      enqueue({ data: { id: 'line-1' } })

      const response = await POST(post(validLine), params)
      expect(response.status).toBe(201)
    })
  })

  it('maps a check_violation from the insert to 400, not 500', async () => {
    enqueue({ data: { id: 'emp-1' } })
    enqueue({ data: null, error: { code: '23514', message: 'violates check constraint' } })

    const response = await POST(post(validLine), params)
    expect(response.status).toBe(400)
  })

  it('still reports a genuine DB failure as 500', async () => {
    enqueue({ data: { id: 'emp-1' } })
    enqueue({ data: null, error: { code: '08006', message: 'connection failure' } })

    const response = await POST(post(validLine), params)
    expect(response.status).toBe(500)
  })
})
