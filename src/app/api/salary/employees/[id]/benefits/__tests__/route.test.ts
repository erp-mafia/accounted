/**
 * Auth-wiring tests for /api/salary/employees/[id]/benefits (GET list, POST
 * create).
 *
 * Runs the route through the real withRouteContext wrapper; mocks auth/company/
 * write and injects a queued Supabase mock via requireAuth. Covers 401, 403
 * (viewer), a POST happy path, and that GET lists active rows only (a removed
 * benefit that a payslip line derives from is kept as is_active=false, #2695).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

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

import { GET, POST } from '../route'

const params = { params: Promise.resolve({ id: 'emp-1' }) } as never

function get() {
  return createMockRequest('/api/salary/employees/emp-1/benefits', { method: 'GET' })
}

function post(body: unknown) {
  return createMockRequest('/api/salary/employees/emp-1/benefits', { method: 'POST', body })
}

describe('GET /api/salary/employees/[id]/benefits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(get(), params)
    expect(response.status).toBe(401)
  })

  it('returns 404 when the employee is not in the company', async () => {
    enqueue({ data: null }) // employee lookup

    const response = await GET(get(), params)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect(body.error).toBe('Anställd hittades inte')
  })

  // The panel is the register the user adds to and removes from. A benefit
  // removed after a run derived a line from it is kept as is_active=false for
  // provenance; listing it here would show a "removed" benefit as live.
  it('lists active benefits only (happy path)', async () => {
    enqueue({ data: { id: 'emp-1' } }) // employee lookup
    enqueue({ data: [{ id: 'ben-1', is_active: true }] }) // benefits

    const response = await GET(get(), params)
    const { status, body } = await parseJsonResponse<{ data: { id: string }[] }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual([{ id: 'ben-1', is_active: true }])
    expect(findCalls('employee_benefits', 'eq')).toContainEqual(['is_active', true])
    expect(findCalls('employee_benefits', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(findCalls('employee_benefits', 'eq')).toContainEqual(['employee_id', 'emp-1'])
  })
})

const validBenefit = {
  benefit_type: 'other',
  description: 'Friskvård',
  monthly_value: 500,
  valid_from: '2026-01-01',
}

describe('POST /api/salary/employees/[id]/benefits', () => {
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

    const response = await POST(post(validBenefit), params)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(post(validBenefit), params)
    expect(response.status).toBe(403)
  })

  it('creates a benefit (happy path)', async () => {
    enqueue({ data: { id: 'emp-1' } }) // employee ownership check
    enqueue({ data: { id: 'ben-1', benefit_type: 'other', monthly_value: 500 } }) // insert

    const response = await POST(post(validBenefit), params)
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)

    expect(status).toBe(201)
    expect(body.data.id).toBe('ben-1')
  })

  it('returns 404 when the employee is not in the company', async () => {
    enqueue({ data: null }) // employee ownership check → not found

    const response = await POST(post(validBenefit), params)
    expect(response.status).toBe(404)
  })

  // Validity period: mirrors CHECK (valid_to IS NULL OR valid_to >= valid_from)
  // on employee_benefits (migration 20260512200100). Before the schema mirrored
  // it, an end date before the start date reached Postgres and came back as an
  // opaque 500.
  describe('valid_from / valid_to ordering', () => {
    it('rejects valid_to before valid_from with an actionable 400', async () => {
      // Queued as the DB would answer without the schema mirror: the employee
      // resolves, then the insert trips the CHECK. The route must never get
      // there; before the mirror this exact input returned an opaque 500.
      enqueue({ data: { id: 'emp-1' } })
      enqueue({
        data: null,
        error: { code: '23514', message: 'violates check constraint "employee_benefits_check"' },
      })

      const response = await POST(
        post({ ...validBenefit, valid_from: '2026-06-01', valid_to: '2026-05-31' }),
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
      // Names both fields as labelled in the form and how to express open-ended.
      expect(body.error).toContain('Gäller till')
      expect(body.error).toContain('Gäller från')
      expect(body.error).toContain('löpande')
      // Nothing was attempted against the DB.
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('accepts valid_to equal to valid_from (the bound is inclusive)', async () => {
      enqueue({ data: { id: 'emp-1' } })
      enqueue({ data: { id: 'ben-1' } })

      const response = await POST(
        post({ ...validBenefit, valid_from: '2026-06-01', valid_to: '2026-06-01' }),
        params,
      )
      expect(response.status).toBe(201)
    })

    it('accepts an omitted valid_to (open-ended benefit stays legal)', async () => {
      enqueue({ data: { id: 'emp-1' } })
      enqueue({ data: { id: 'ben-1' } })

      const response = await POST(post(validBenefit), params)
      expect(response.status).toBe(201)
    })

    it('maps a check_violation from the insert to 400, not 500', async () => {
      enqueue({ data: { id: 'emp-1' } })
      enqueue({ data: null, error: { code: '23514', message: 'violates check constraint' } })

      const response = await POST(post(validBenefit), params)
      expect(response.status).toBe(400)
    })

    it('still reports a genuine DB failure as 500', async () => {
      enqueue({ data: { id: 'emp-1' } })
      enqueue({ data: null, error: { code: '08006', message: 'connection failure' } })

      const response = await POST(post(validBenefit), params)
      expect(response.status).toBe(500)
    })
  })
})
