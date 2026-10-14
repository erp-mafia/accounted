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

    it("rejects the removed 'other' addition type", async () => {
      const response = await POST(
        post({ ...validLine, item_type: 'other', amount: 500 }),
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

// Text rows (item_type 'text', lib/salary/text-rows.ts): a standing row of
// words on every payslip, no amount and no account.
describe('POST /api/salary/employees/[id]/recurring-lines: text rows', () => {
  const textLine = {
    item_type: 'text',
    description: 'Grundlön 40 000 kr + personligt tillägg 2 000 kr',
    valid_from: '2026-01-01',
  }

  function authedWithCalls() {
    const mock = createQueuedMockSupabase()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mock.supabase })
    return mock
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 for a text row when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(post(textLine), params)
    expect(response.status).toBe(401)
  })

  it('creates a text row with no amount: amount 0, no account, words normalised (201)', async () => {
    const { enqueue: enqueueOwn, findCall } = authedWithCalls()
    enqueueOwn({ data: { id: 'emp-1' } }) // employee ownership check
    enqueueOwn({ data: { id: 'line-text', item_type: 'text', amount: 0 } }) // insert

    const response = await POST(
      post({ ...textLine, description: ' Grundlön 40 000 kr\n + personligt tillägg 2 000 kr ', account_number: '7210' }),
      params,
    )
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)

    expect(status).toBe(201)
    expect(body.data.id).toBe('line-text')
    expect(findCall('employee_recurring_lines', 'insert')?.[0]).toMatchObject({
      employee_id: 'emp-1',
      company_id: 'company-1',
      item_type: 'text',
      description: 'Grundlön 40 000 kr + personligt tillägg 2 000 kr',
      amount: 0,
      account_number: null,
    })
  })

  it('accepts an explicit 0 on a text row', async () => {
    const { enqueue: enqueueOwn } = authedWithCalls()
    enqueueOwn({ data: { id: 'emp-1' } })
    enqueueOwn({ data: { id: 'line-text' } })
    const response = await POST(post({ ...textLine, amount: 0 }), params)
    expect(response.status).toBe(201)
  })

  it('returns a field-level 400 for a text row with an amount, before any database call', async () => {
    const mock = authedWithCalls()
    for (const amount of [500, -500]) {
      const response = await POST(post({ ...textLine, amount }), params)
      const { status, body } = await parseJsonResponse<{ errors: { field: string; message: string }[] }>(response)
      expect(status).toBe(400)
      expect(body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'amount', message: expect.stringMatching(/textrad har inget belopp/) })]),
      )
    }
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 for a text row with no words', async () => {
    const mock = authedWithCalls()
    const response = await POST(post({ ...textLine, description: ' \n ' }), params)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)
    expect(status).toBe(400)
    expect(body.error).toBe('En textrad måste ha en text.')
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 for a deduction row without an amount (0 kr money row)', async () => {
    const mock = authedWithCalls()
    const response = await POST(
      post({ item_type: 'gross_deduction_other', description: 'Bruttolöneavdrag', valid_from: '2026-01-01' }),
      params,
    )
    expect(response.status).toBe(400)
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 for a text row on an employee outside the company', async () => {
    const { enqueue: enqueueOwn, findCall } = authedWithCalls()
    enqueueOwn({ data: null })
    const response = await POST(post(textLine), params)
    expect(response.status).toBe(404)
    expect(findCall('employee_recurring_lines', 'insert')).toBeUndefined()
  })
})
